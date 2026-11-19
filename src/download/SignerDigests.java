import com.android.apksig.ApkVerifier;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Prints the SHA-256 of each verified signer certificate of one or more
 * APKs, computed over the DER bytes of the certificates in apksig's
 * verification result. apksigner's text output is never read, because it
 * prints the certificate subject, which the APK's signer chooses.
 *
 * Run with apksigner.jar from Android build-tools on the classpath:
 *
 *   java -cp .../lib/apksigner.jar SignerDigests.java a.apk [b.apk ...]
 *
 * Output, one item per line. Nothing from an APK is printed raw:
 *   apk <n>                      starts the n-th APK's section (from 0)
 *   sha256 <64 lower-case hex>   a signer certificate's digest
 *   subject <base64 of UTF-8>    the first signer's subject, for display only
 *   error <base64 of UTF-8>      the APK doesn't verify
 */
public class SignerDigests {
    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("usage: SignerDigests <apk>...");
            System.exit(2);
        }
        for (int i = 0; i < args.length; i++) {
            System.out.println("apk " + i);
            try {
                report(new ApkVerifier.Builder(new File(args[i])).build().verify());
            } catch (Exception e) {
                System.out.println("error " + base64(String.valueOf(e)));
            }
        }
    }

    private static void report(ApkVerifier.Result result) throws Exception {
        if (!result.isVerified()) {
            System.out.println("error " + base64("DOES NOT VERIFY: " + result.getAllErrors()));
            return;
        }
        List<X509Certificate> certs = new ArrayList<>(result.getSignerCertificates());
        // A v3.1 signer (a rotated key used from a later Android version) is a
        // signer too; apksigner lists it as "Signer (minSdkVersion=...)".
        for (ApkVerifier.Result.V3SchemeSignerInfo signer : result.getV31SchemeSigners()) {
            certs.add(signer.getCertificate());
        }
        for (X509Certificate cert : certs) {
            System.out.println("sha256 " + hex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded())));
        }
        if (!certs.isEmpty()) {
            System.out.println("subject " + base64(certs.get(0).getSubjectX500Principal().getName()));
        }
    }

    private static String base64(String text) {
        return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }
}
