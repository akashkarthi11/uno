package com.uno;

/** color: red|yellow|green|blue|wild. value: 0-9, skip, reverse, draw2, wild, wild4. */
public record Card(int id, String color, String value) {
}
