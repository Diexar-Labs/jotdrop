import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLStreamHandler;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

// Run after :app:compileDebugKotlin with its classes, android.jar and Kotlin stdlib on the classpath.
class CheckAndroidTransport {
    static final List<String> requests = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        URL.setURLStreamHandlerFactory(protocol -> protocol.equals("https") || protocol.equals("http") ? new URLStreamHandler() {
            protected HttpURLConnection openConnection(URL url) {
                requests.add(url.toString());
                if (!url.getProtocol().equals("https") || !url.getHost().equals("example.com")) {
                    throw new AssertionError("Unsafe target connected: " + url);
                }
                return new HttpURLConnection(url) {
                    public void connect() {}
                    public void disconnect() {}
                    public boolean usingProxy() { return false; }
                    public int getResponseCode() {
                        if (getInstanceFollowRedirects()) throw new AssertionError("Automatic redirect enabled");
                        String path = url.getPath();
                        if (path.equals("/ok")) return 200;
                        if (path.startsWith("/status/")) return Integer.parseInt(path.substring(8));
                        return 302;
                    }
                    public String getHeaderField(String name) {
                        if (!name.equals("Location")) return null;
                        return switch (url.getPath()) {
                            case "/http" -> "http://example.com/ok";
                            case "/private" -> "https://192.168.1.1/private";
                            case "/local" -> "https://localhost/private";
                            case "/loop" -> "/loop";
                            default -> "/ok";
                        };
                    }
                    public String getContentType() { return "text/html; charset=UTF-8"; }
                    public InputStream getInputStream() { return new ByteArrayInputStream("preview".getBytes()); }
                };
            }
        } : null);
        Class<?> fetcher = Class.forName("com.diexar.keepcapture.OgFetcher");
        Object instance = fetcher.getField("INSTANCE").get(null);
        Method download = Arrays.stream(fetcher.getDeclaredMethods())
            .filter(method -> method.getName().startsWith("downloadHtml-") && method.getParameterCount() == 3)
            .findFirst().orElseThrow();
        download.setAccessible(true);

        for (int code : new int[] {301, 302, 303, 307, 308}) {
            requests.clear();
            Object result = download.invoke(instance, "https://example.com/status/" + code, "test", 6);
            if (!"preview".equals(result) || requests.size() != 2) throw new AssertionError("Redirect " + code);
        }
        for (String path : new String[] {"http", "private", "local", "loop"}) {
            requests.clear();
            Object result = download.invoke(instance, "https://example.com/" + path, "test", 6);
            if (!result.getClass().getName().equals("kotlin.Result$Failure")) throw new AssertionError("Unsafe result " + path);
            if (requests.size() != (path.equals("loop") ? 7 : 1)) throw new AssertionError("Unsafe redirect " + requests);
        }
        requests.clear();
        Object result = download.invoke(instance, "http://example.com/ok", "test", 6);
        if (!requests.isEmpty() || !result.getClass().getName().equals("kotlin.Result$Failure")) {
            throw new AssertionError("Plain HTTP must fail before connecting");
        }
        System.out.println("Android transport: HTTPS redirects, downgrade/private-host refusal and redirect limits passed");
    }
}
