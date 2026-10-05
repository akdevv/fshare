package expo.modules.fsharepeer

import android.util.Base64
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// End-to-end encryption, byte for byte the spec in cli/seal.ts (and Seal.swift):
// keys from the pairing token, signed requests, sealed messages, files sealed in 64 KiB chunks,
// and ECDH P-256 for pairing two phones.
object Seal {
  const val CH = 65536
  private const val TAG = 16
  private const val SALT = 7
  private val random = SecureRandom()

  class Keys(val enc: ByteArray, val mac: ByteArray)

  fun hmac(key: ByteArray, msg: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(msg) }

  fun keys(token: String): Keys {
    val root = hmac("fshare-e2e-1".toByteArray(), token.toByteArray())
    return Keys(hmac(root, "enc".toByteArray()), hmac(root, "mac".toByteArray()))
  }

  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
  private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  private fun unb64(s: String): ByteArray? = try { Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP) } catch (_: IllegalArgumentException) { null }

  fun sign(token: String, msg: String) = hex(hmac(keys(token).mac, msg.toByteArray()).copyOf(16))

  // "GET /list?c=1&s=…" as it came off the wire
  fun verify(token: String, method: String, target: String): Boolean {
    val m = Regex("[?&]s=([0-9a-f]{32})$").find(target) ?: return false
    val want = sign(token, "$method ${target.substring(0, m.range.first)}")
    return MessageDigest.isEqual(want.toByteArray(), m.groupValues[1].toByteArray())
  }

  private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray) =
    Cipher.getInstance("AES/GCM/NoPadding").apply { init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG * 8, nonce)) }

  fun seal(token: String, data: ByteArray): String {
    val iv = ByteArray(12).also { random.nextBytes(it) }
    return b64(iv + gcm(Cipher.ENCRYPT_MODE, keys(token).enc, iv).doFinal(data))
  }

  fun open(token: String, sealed: String): ByteArray? {
    val b = unb64(sealed) ?: return null
    if (b.size < 12 + TAG) return null
    return try { gcm(Cipher.DECRYPT_MODE, keys(token).enc, b.copyOf(12)).doFinal(b, 12, b.size - 12) } catch (_: Exception) { null }
  }

  fun openText(token: String, sealed: String?) = sealed?.let { open(token, it) }?.toString(Charsets.UTF_8)

  fun sealedSize(size: Long): Long = SALT + size + TAG * (if (size == 0L) 1 else (size + CH - 1) / CH)

  private fun nonce(salt: ByteArray, i: Int, last: Boolean) = ByteArray(12).also {
    System.arraycopy(salt, 0, it, 0, SALT)
    it[SALT] = if (last) 1 else 0
    it[8] = (i ushr 24).toByte(); it[9] = (i ushr 16).toByte(); it[10] = (i ushr 8).toByte(); it[11] = i.toByte()
  }

  // `seed` picks the salt, so sealing the same file for the same upload id gives the same bytes and
  // a retry can carry on from what the other side already has
  fun sealFile(token: String, input: InputStream, size: Long, out: OutputStream, seed: String) {
    val k = keys(token)
    val salt = hmac(k.mac, "up\u0000$seed".toByteArray()).copyOf(SALT)
    out.write(salt)
    val n = if (size == 0L) 1L else (size + CH - 1) / CH
    val buf = ByteArray(CH)
    for (i in 0 until n) {
      val want = minOf(CH.toLong(), size - i * CH).toInt()
      readFully(input, buf, want)
      out.write(gcm(Cipher.ENCRYPT_MODE, k.enc, nonce(salt, i.toInt(), i == n - 1)).doFinal(buf, 0, want))
    }
    if (input.read() >= 0) throw IOException("file changed while sealing")
  }

  // the file back out of a sealed stream; throws on anything tampered with, reordered or cut short
  fun openFile(token: String, input: InputStream, out: OutputStream): Long {
    val enc = keys(token).enc
    val salt = ByteArray(SALT).also { readFully(input, it, SALT) }
    val cur = ByteArray(CH + TAG)
    var have = readUpTo(input, cur, 0)
    var i = 0
    var total = 0L
    while (true) {
      // a full chunk with more after it isn't the last one
      val peek = if (have == cur.size) input.read() else -1
      val last = peek < 0
      if (have < TAG) throw IOException("cut short")
      val plain = gcm(Cipher.DECRYPT_MODE, enc, nonce(salt, i++, last)).doFinal(cur, 0, have)
      out.write(plain)
      total += plain.size
      if (last) return total
      cur[0] = peek.toByte()
      have = readUpTo(input, cur, 1)
    }
  }

  private fun readFully(input: InputStream, buf: ByteArray, n: Int) {
    var off = 0
    while (off < n) { val k = input.read(buf, off, n - off); if (k < 0) throw EOFException(); off += k }
  }

  private fun readUpTo(input: InputStream, buf: ByteArray, from: Int): Int {
    var off = from
    while (off < buf.size) { val k = input.read(buf, off, buf.size - off); if (k < 0) break; off += k }
    return off
  }

  // phone pairing: each side makes a key, swaps the public half, and both end up with the same
  // secret and the same 6-digit code to compare on screen
  class Pairing {
    private val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val params = (kp.public as ECPublicKey).params
    val pub: String = (kp.public as ECPublicKey).w.let { b64(byteArrayOf(4) + fixed(it.affineX) + fixed(it.affineY)) }

    // (secret, code)
    fun finish(theirPub: String): kotlin.Pair<String, String> {
      val b = unb64(theirPub)
      if (b == null || b.size != 65 || b[0] != 4.toByte()) throw IllegalArgumentException("bad key")
      val point = ECPoint(BigInteger(1, b.copyOfRange(1, 33)), BigInteger(1, b.copyOfRange(33, 65)))
      val them = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
      val z = KeyAgreement.getInstance("ECDH").run { init(kp.private); doPhase(them, true); generateSecret() }
      val secret = hex(hmac("fshare-pair-1".toByteArray(), z))
      val h = hmac(keys(secret).mac, "code".toByteArray())
      val n = ((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)
      return kotlin.Pair(secret, (n % 1_000_000).toString().padStart(6, '0'))
    }

    private fun fixed(v: BigInteger): ByteArray {
      val b = v.toByteArray()
      return when {
        b.size == 32 -> b
        b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
        else -> ByteArray(32 - b.size) + b
      }
    }
  }
}
