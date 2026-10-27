package com.uno;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.springframework.web.socket.WebSocketSession;

/** One UNO table. The server is authoritative; every public method is synchronized on the room. */
public class Room {

    private static final List<String> COLORS = List.of("red", "yellow", "green", "blue");
    private static final int MAX_SEATS = 8;
    private static final int INITIAL_HAND = 5;
    private static final int MAX_LOG = 40;
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Random RANDOM = new Random();
    private static final ScheduledExecutorService TIMER = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "uno-auto-turn");
        t.setDaemon(true);
        return t;
    });

    private final String code;
    private final List<Player> members = new ArrayList<>();
    private final LinkedList<String> log = new LinkedList<>();
    private List<Player> seats = new ArrayList<>();
    private List<Card> deck = new ArrayList<>();
    private List<Card> discard = new ArrayList<>();
    private String hostId;
    private String color;
    private String winner;
    private String loser;
    private final List<String> ranking = new ArrayList<>();
    private String unoId;
    private String notice;
    private boolean started;
    private boolean over;
    private int cur;
    private int dir = 1;
    private Integer drawnId;

    public Room(String code) {
        this.code = code;
    }

    /* ---------------- membership ---------------- */

    public synchronized Player join(String knownId, String rawName, WebSocketSession session, boolean admin) {
        Player p = knownId == null ? null : byId(knownId);
        if (p == null) {
            p = new Player(UUID.randomUUID().toString(), cleanName(rawName));
            members.add(p);
            addLog(p.name + " joined" + (started && !over ? " (waiting for the next game)." : "."));
        } else {
            addLog(p.name + " reconnected.");
        }
        p.session = session;
        p.admin = admin;
        if (admin) {
            hostId = p.id;
        }
        checkAutoTurn();
        broadcast();
        return p;
    }

    /** Returns the number of connected members left in the room. */
    public synchronized int disconnect(WebSocketSession session) {
        Player gone = null;
        for (Player m : members) {
            if (m.session == session) {
                gone = m;
            }
        }
        if (gone != null) {
            gone.session = null;
            addLog(gone.name + " left.");
            if (!started || over) {
                members.remove(gone);
            }
            if (gone.id.equals(hostId)) {
                hostId = members.stream().filter(m -> m.admin && m.connected()).map(m -> m.id).findFirst().orElse(null);
            }
            if (started && !over && connectedSeats() < 2) {
                over = true;
                winner = null;
                loser = null;
                notice = "Game ended: not enough players left.";
            }
            checkAutoTurn();
            broadcast();
        }
        return (int) members.stream().filter(Player::connected).count();
    }

    /* ---------------- messages ---------------- */

    public synchronized void handle(Player p, JsonNode m) {
        try {
            switch (m.path("type").asText()) {
                case "start" -> start(p);
                case "play" -> play(p, m.path("cardId").asInt(-1), m.path("color").asText(""));
                case "draw" -> draw(p);
                case "pass" -> pass(p);
                case "uno" -> sayUno(p);
                case "catch" -> catchUno(p);
                default -> { }
            }
        } catch (IllegalStateException e) {
            p.send(json(Map.of("type", "error", "message", e.getMessage())));
            return;
        }
        broadcast();
    }

    private void start(Player p) {
        if (!p.id.equals(hostId)) {
            throw new IllegalStateException("Only the admin can start the game.");
        }
        if (started && !over) {
            throw new IllegalStateException("A game is already running.");
        }
        members.removeIf(m -> !m.connected());
        if (members.size() < 2) {
            throw new IllegalStateException("At least 2 players are needed.");
        }
        seats = new ArrayList<>(members.subList(0, Math.min(MAX_SEATS, members.size())));
        deck = buildDeck();
        Collections.shuffle(deck, RANDOM);
        discard = new ArrayList<>();
        for (Player s : seats) {
            s.hand.clear();
            s.saidUno = false;
            s.finished = false;
            give(s, INITIAL_HAND);
        }
        ranking.clear();
        loser = null;
        Card first = deck.remove(deck.size() - 1);
        while (first.color().equals("wild") || List.of("skip", "reverse", "draw2").contains(first.value())) {
            deck.add(0, first);
            Collections.shuffle(deck, RANDOM);
            first = deck.remove(deck.size() - 1);
        }
        discard.add(first);
        color = first.color();
        dir = 1;
        cur = RANDOM.nextInt(seats.size());
        drawnId = null;
        unoId = null;
        winner = null;
        notice = null;
        started = true;
        over = false;
        log.clear();
        addLog("Game started with " + seats.size() + " players. First card: " + first.color() + " " + first.value());
        addLog(seats.get(cur).name + " goes first.");
        checkAutoTurn();
    }

    private void play(Player p, int cardId, String chosen) {
        requireTurn(p);
        Card c = find(p.hand, cardId);
        if (c == null) {
            throw new IllegalStateException("That card is not in your hand.");
        }
        if (drawnId != null && c.id() != drawnId) {
            throw new IllegalStateException("You may only play the card you just drew.");
        }
        if (!playable(c, p)) {
            throw new IllegalStateException(c.value().equals("wild4")
                    ? "Wild Draw Four is only legal when you hold no card of the current colour."
                    : "You can't play that card.");
        }
        if (c.color().equals("wild") && !COLORS.contains(chosen)) {
            throw new IllegalStateException("Choose a colour.");
        }
        beforeAction(p);
        doPlay(p, c, chosen);
    }

    private void draw(Player p) {
        requireTurn(p);
        if (drawnId != null) {
            throw new IllegalStateException("You already drew a card this turn.");
        }
        beforeAction(p);
        drawOne(p);
    }

    private void drawOne(Player p) {
        Card c = takeFromDeck();
        p.hand.add(c);
        addLog(p.name + " draws a card.");
        if (playable(c, p)) {
            drawnId = c.id();
        } else {
            advance(1);
        }
    }

    private void pass(Player p) {
        requireTurn(p);
        if (drawnId == null) {
            throw new IllegalStateException("Draw a card before passing.");
        }
        beforeAction(p);
        addLog(p.name + " passes.");
        advance(1);
    }

    private void sayUno(Player p) {
        if (!started || over || !seats.contains(p)) {
            throw new IllegalStateException("No game running.");
        }
        if (p.hand.size() > 2) {
            throw new IllegalStateException("You can call GrowX when you have 2 or fewer cards.");
        }
        p.saidUno = true;
        if (p.id.equals(unoId)) {
            unoId = null;
        }
        addLog(p.name + " says GrowX!");
    }

    private void catchUno(Player p) {
        Player target = unoId == null ? null : byId(unoId);
        if (target == null || target == p || target.hand.size() != 1) {
            throw new IllegalStateException("Nobody to catch.");
        }
        give(target, 2);
        unoId = null;
        addLog(p.name + " caught " + target.name + " without calling GrowX — draws 2.");
    }

    /* ---------------- rules ---------------- */

    private void requireTurn(Player p) {
        if (!started || over) {
            throw new IllegalStateException("No game running.");
        }
        if (seats.get(cur) != p) {
            throw new IllegalStateException("It is not your turn.");
        }
    }

    /** Anyone acting after a player dropped to one card without UNO makes that player draw 2. */
    private void beforeAction(Player actor) {
        if (unoId == null) {
            return;
        }
        Player u = byId(unoId);
        if (u != null && u != actor && u.hand.size() == 1 && !u.saidUno) {
            give(u, 2);
            addLog(u.name + " forgot to call GrowX — draws 2.");
        }
        unoId = null;
    }

    private boolean playable(Card c, Player p) {
        if (c.value().equals("wild4")) {
            return p.hand.stream().noneMatch(h -> h.color().equals(color));
        }
        if (c.color().equals("wild")) {
            return true;
        }
        return c.color().equals(color) || c.value().equals(top().value());
    }

    private void doPlay(Player p, Card c, String chosen) {
        p.hand.remove(c);
        discard.add(c);
        color = c.color().equals("wild") ? chosen : c.color();
        drawnId = null;
        addLog(p.name + " played " + (c.color().equals("wild") ? "" : c.color() + " ") + c.value()
                + (c.color().equals("wild") ? " → " + color : ""));

        if (p.hand.isEmpty()) {
            p.finished = true;
            ranking.add(p.name);
            addLog(p.name + " is out of cards — #" + ranking.size() + "!");
            List<Player> left = activePlayers();
            if (left.size() <= 1) {
                over = true;
                winner = ranking.get(0);
                loser = left.isEmpty() ? null : left.get(0).name;
                notice = null;
                addLog(loser == null ? "Game over." : loser + " is left holding cards and loses!");
                return;
            }
        } else if (p.hand.size() == 1) {
            if (p.saidUno) {
                addLog(p.name + " has one card left!");
            } else {
                unoId = p.id;
            }
        } else if (p.hand.size() > 2) {
            p.saidUno = false;
        }

        Player target = seats.get(index(cur, 1));
        boolean skip = false;
        switch (c.value()) {
            case "skip" -> {
                skip = true;
                addLog(target.name + " is skipped.");
            }
            case "reverse" -> {
                dir = -dir;
                skip = !p.finished && activePlayers().size() == 2;
                addLog("Direction reversed.");
            }
            case "draw2" -> {
                give(target, 2);
                skip = true;
                addLog(target.name + " draws 2.");
            }
            case "wild4" -> {
                give(target, 4);
                skip = true;
                addLog(target.name + " draws 4.");
            }
            default -> { }
        }
        advance(skip ? 2 : 1);
    }

    private void advance(int steps) {
        cur = index(cur, steps);
        drawnId = null;
        checkAutoTurn();
    }

    /** Moves {@code steps} active seats in the current direction, skipping players who are already out. */
    private int index(int from, int steps) {
        int n = seats.size();
        int i = from;
        for (int s = 0; s < steps; s++) {
            do {
                i = ((i + dir) % n + n) % n;
            } while (seats.get(i).finished);
        }
        return i;
    }

    private List<Player> activePlayers() {
        return seats.stream().filter(p -> !p.finished).toList();
    }

    private Card top() {
        return discard.get(discard.size() - 1);
    }

    private Card takeFromDeck() {
        if (deck.isEmpty()) {
            Card t = discard.remove(discard.size() - 1);
            deck = new ArrayList<>(discard);
            discard.clear();
            discard.add(t);
            Collections.shuffle(deck, RANDOM);
            addLog("Draw pile reshuffled.");
        }
        return deck.remove(deck.size() - 1);
    }

    private void give(Player p, int n) {
        for (int i = 0; i < n && !(deck.isEmpty() && discard.size() <= 1); i++) {
            p.hand.add(takeFromDeck());
        }
        if (p.hand.size() > 2) {
            p.saidUno = false;
        }
    }

    private static List<Card> buildDeck() {
        List<Card> d = new ArrayList<>(108);
        int id = 0;
        for (String c : COLORS) {
            d.add(new Card(id++, c, "0"));
            for (int n = 1; n <= 9; n++) {
                d.add(new Card(id++, c, String.valueOf(n)));
                d.add(new Card(id++, c, String.valueOf(n)));
            }
            for (String v : List.of("skip", "reverse", "draw2")) {
                d.add(new Card(id++, c, v));
                d.add(new Card(id++, c, v));
            }
        }
        for (int i = 0; i < 4; i++) {
            d.add(new Card(id++, "wild", "wild"));
            d.add(new Card(id++, "wild", "wild4"));
        }
        return d;
    }

    /* ---------------- disconnected players ---------------- */

    private int connectedSeats() {
        return (int) seats.stream().filter(p -> !p.finished && p.connected()).count();
    }

    /** A disconnected player's turn is played automatically so the table never stalls. */
    private void checkAutoTurn() {
        if (!started || over) {
            return;
        }
        final Player p = seats.get(cur);
        if (p.connected()) {
            return;
        }
        TIMER.schedule(() -> {
            try {
                synchronized (Room.this) {
                    if (!started || over || seats.get(cur) != p || p.connected()) {
                        return;
                    }
                    autoPlay(p);
                    broadcast();
                }
            } catch (RuntimeException ignored) {
                // never let the timer thread die
            }
        }, 2, TimeUnit.SECONDS);
    }

    private void autoPlay(Player p) {
        beforeAction(p);
        Card pick = p.hand.stream().filter(c -> playable(c, p))
                .min(Comparator.comparing((Card c) -> c.color().equals("wild"))).orElse(null);
        if (pick != null) {
            doPlay(p, pick, commonColor(p));
            return;
        }
        drawOne(p);
        if (drawnId != null) {
            Card drawn = find(p.hand, drawnId);
            doPlay(p, drawn, commonColor(p));
        }
    }

    private String commonColor(Player p) {
        Map<String, Integer> count = new LinkedHashMap<>();
        COLORS.forEach(c -> count.put(c, 0));
        p.hand.stream().filter(c -> !c.color().equals("wild")).forEach(c -> count.merge(c.color(), 1, Integer::sum));
        return count.entrySet().stream().max(Map.Entry.comparingByValue()).get().getKey();
    }

    /* ---------------- output ---------------- */

    private void broadcast() {
        for (Player m : new ArrayList<>(members)) {
            if (m.connected()) {
                m.send(stateFor(m));
            }
        }
    }

    private String stateFor(Player me) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", "state");
        s.put("room", code);
        s.put("you", me.id);
        s.put("host", hostId);
        s.put("started", started);
        s.put("over", over);
        s.put("winner", winner);
        s.put("loser", loser);
        s.put("ranking", new ArrayList<>(ranking));
        s.put("notice", notice);
        s.put("seated", seats.contains(me) && started);

        List<Map<String, Object>> ps = new ArrayList<>();
        for (Player p : started ? seats : members) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("id", p.id);
            o.put("name", p.name);
            o.put("count", p.hand.size());
            o.put("finished", started && p.finished);
            o.put("connected", p.connected());
            ps.add(o);
        }
        s.put("players", ps);
        s.put("log", new ArrayList<>(log));

        if (started) {
            s.put("top", top());
            s.put("color", color);
            s.put("dir", dir);
            s.put("cur", seats.get(cur).id);
            s.put("deck", deck.size());
            s.put("drawn", drawnId);
            List<Card> hand = new ArrayList<>(me.hand);
            hand.sort(Comparator.comparing((Card c) -> COLORS.indexOf(c.color())).thenComparing(Card::value));
            s.put("hand", hand);
            boolean myTurn = !over && seats.get(cur) == me;
            List<Integer> ok = new ArrayList<>();
            if (myTurn) {
                for (Card c : me.hand) {
                    if ((drawnId == null || c.id() == drawnId) && playable(c, me)) {
                        ok.add(c.id());
                    }
                }
            }
            s.put("playable", ok);
            Player u = unoId == null ? null : byId(unoId);
            s.put("canCatch", !over && u != null && u != me && seats.contains(me) && u.hand.size() == 1);
        }
        return json(s);
    }

    /* ---------------- helpers ---------------- */

    private Player byId(String id) {
        for (Player m : members) {
            if (m.id.equals(id)) {
                return m;
            }
        }
        for (Player m : seats) {
            if (m.id.equals(id)) {
                return m;
            }
        }
        return null;
    }

    private static Card find(List<Card> hand, Integer id) {
        for (Card c : hand) {
            if (id != null && c.id() == id) {
                return c;
            }
        }
        return null;
    }

    private void addLog(String msg) {
        log.add(msg);
        while (log.size() > MAX_LOG) {
            log.removeFirst();
        }
    }

    private static String cleanName(String raw) {
        String n = raw == null ? "" : raw.trim().replaceAll("[<>&\"']", "");
        if (n.isEmpty()) {
            n = "Player" + (100 + RANDOM.nextInt(900));
        }
        return n.length() > 16 ? n.substring(0, 16) : n;
    }

    private static String json(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
