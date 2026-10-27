package com.uno;

import java.util.ArrayList;
import java.util.List;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

public class Player {
    final String id;
    final String name;
    final List<Card> hand = new ArrayList<>();
    volatile WebSocketSession session;
    boolean saidUno;
    boolean admin;
    boolean finished;

    Player(String id, String name) {
        this.id = id;
        this.name = name;
    }

    boolean connected() {
        WebSocketSession s = session;
        return s != null && s.isOpen();
    }

    void send(String json) {
        WebSocketSession s = session;
        if (s == null || !s.isOpen()) {
            return;
        }
        try {
            synchronized (s) {
                s.sendMessage(new TextMessage(json));
            }
        } catch (Exception ignored) {
            // a failed send is handled by the close callback
        }
    }
}
