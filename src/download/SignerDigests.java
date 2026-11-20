import com.android.apksig.ApkVerifier;
import com.android.apksig.SigningCertificateLineage;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

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
        // Every verified signer of every scheme, as apksigner lists them. One
        // scheme alone isn't enough: an APK with a rotated key (v3.1, e.g.
        // Instagram, Gboard) is signed by the new key for later Android
        // versions and by the original key in v2/v3, and
        // getSignerCertificates() returns only one of them. Ignored v1
        // signers and the source stamp are left out.
        List<X509Certificate> certs = new ArrayList<>(result.getSignerCertificates());
        for (ApkVerifier.Result.V1SchemeSignerInfo signer : result.getV1SchemeSigners()) {
            certs.add(signer.getCertificate());
        }
        for (ApkVerifier.Result.V2SchemeSignerInfo signer : result.getV2SchemeSigners()) {
            certs.add(signer.getCertificate());
        }
        for (ApkVerifier.Result.V3SchemeSignerInfo signer : result.getV3SchemeSigners()) {
            certs.add(signer.getCertificate());
        }
        for (ApkVerifier.Result.V3SchemeSignerInfo signer : result.getV31SchemeSigners()) {
            certs.add(signer.getCertificate());
        }
        // From minSdk 28 apksig checks only v3, so after a rotation the
        // original key may appear only in the lineage. apksig verifies each
        // link (an older key signs the next), so its keys are the developer's.
        SigningCertificateLineage lineage = result.getSigningCertificateLineage();
        if (lineage != null) {
            certs.addAll(lineage.getCertificatesInLineage());
        }
        Set<String> digests = new LinkedHashSet<>();
        for (X509Certificate cert : certs) {
            if (cert != null) digests.add(hex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded())));
        }
        for (String digest : digests) {
            System.out.println("sha256 " + digest);
        }
        if (!certs.isEmpty() && certs.get(0) != null) {
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
