package android.net;
// JVM stand-in for the bits of android.net.Uri the server uses
public class Uri {
  private final java.net.URI u;
  private Uri(java.net.URI u) { this.u = u; }
  public static Uri parse(String s) { return new Uri(java.net.URI.create(s)); }
  public static Uri fromFile(java.io.File f) { return new Uri(f.toURI()); }
  public String getPath() { return u.getPath(); }
  public String getQueryParameter(String k) {
    String q = u.getRawQuery();
    if (q == null) return null;
    for (String p : q.split("&")) {
      int i = p.indexOf('=');
      String name = i < 0 ? p : p.substring(0, i);
      if (name.equals(k)) return i < 0 ? "" : java.net.URLDecoder.decode(p.substring(i + 1), java.nio.charset.StandardCharsets.UTF_8);
    }
    return null;
  }
  public static String decode(String s) { return java.net.URLDecoder.decode(s, java.nio.charset.StandardCharsets.UTF_8); }
  @Override public String toString() { return u.toString(); }
}
