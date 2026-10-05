package org.json;
public class JSONObject {
  private final java.util.Map<?, ?> m;
  public JSONObject(java.util.Map<?, ?> m) { this.m = m; }
  public static String q(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
  @Override public String toString() {
    StringBuilder b = new StringBuilder("{");
    for (java.util.Map.Entry<?, ?> e : m.entrySet()) {
      if (b.length() > 1) b.append(',');
      Object v = e.getValue();
      b.append(q(e.getKey().toString())).append(':').append(v instanceof String ? q((String) v) : v instanceof Number || v instanceof JSONArray ? v.toString() : v == null ? "null" : q(v.toString()));
    }
    return b.append('}').toString();
  }
}
