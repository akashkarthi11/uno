package com.uno;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class GameSocketHandler extends TextWebSocketHandler {

    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${uno.player-password:123456}")
    private String playerPassword;

    @Value("${uno.admin-password:110299}")
    private String adminPassword;

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        JsonNode m = mapper.readTree(message.getPayload());
        Map<String, Object> attrs = session.getAttributes();

        if ("join".equals(m.path("type").asText())) {
            if (attrs.containsKey("player")) {
                return;
            }
            String pw = m.path("password").asText("");
            boolean admin = pw.equals(adminPassword);
            if (!admin && !pw.equals(playerPassword)) {
                session.sendMessage(new TextMessage("{\"type\":\"denied\",\"message\":\"Wrong password.\"}"));
                session.close(CloseStatus.POLICY_VIOLATION);
                return;
            }
            String code = cleanRoom(m.path("room").asText(""));
            Room room = rooms.computeIfAbsent(code, Room::new);
            String known = m.hasNonNull("playerId") ? m.get("playerId").asText() : null;
            Player p = room.join(known, m.path("name").asText(""), session, admin);
            attrs.put("room", code);
            attrs.put("player", p);
            return;
        }

        Room room = rooms.get((String) attrs.get("room"));
        Player p = (Player) attrs.get("player");
        if (room != null && p != null) {
            room.handle(p, m);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String code = (String) session.getAttributes().get("room");
        Room room = code == null ? null : rooms.get(code);
        if (room != null && room.disconnect(session) == 0) {
            rooms.remove(code, room);
        }
    }

    private static String cleanRoom(String raw) {
        String r = raw.trim();
        return r.matches("[A-Za-z0-9_-]{1,24}") ? r : "main";
    }
}
