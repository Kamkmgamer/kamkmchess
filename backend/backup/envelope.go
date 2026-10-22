package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"time"
)

const (
	// ContainerMagic identifies a KHA encrypted logical backup container.
	ContainerMagic = "KHA-BACKUP\x01"
	// SchemaVersion is the container and manifest schema version.
	SchemaVersion = 1

	algorithmKDF = "AES-256-GCM"
	kdfName      = "PBKDF2-HMAC-SHA256"
	kdfKeyLength = 32
	saltLength   = 16
	nonceLength  = 12
	// kdfIterations is a reviewable floor. A container records the iteration
	// count it was written with, so raising this never breaks older bundles.
	kdfIterations = 210_000

	// MinPassphraseLength rejects trivially weak operator passphrases.
	MinPassphraseLength = 12
	// MaxPlaintextBytes bounds one bundle in memory. This is an honest MVP
	// limit, not a streaming design: a logical export above this size must be
	// split by an operator or the export contract has to be redesigned.
	MaxPlaintextBytes = 256 << 20

	headerPrefix = len(ContainerMagic) + 4
	trailerSize  = sha256.Size
)

var (
	ErrMalformedContainer = errors.New("backup: malformed container")
	ErrUnsupportedVersion = errors.New("backup: unsupported container version")
	ErrPassphrase         = errors.New("backup: passphrase rejected")
	ErrDigestMismatch     = errors.New("backup: digest mismatch")
	ErrTooLarge           = errors.New("backup: bundle exceeds the supported size")
	ErrLabelInvalid       = errors.New("backup: invalid rotation label")
	ErrLedgerConflict     = errors.New("backup: conflicting tombstone ledger")
)

// Cipher describes the authenticated encryption parameters of one container.
// It is intentionally non-secret so a restore operator can see how a bundle
// was sealed before supplying a passphrase.
type Cipher struct {
	Algorithm  string `json:"algorithm"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	Nonce      string `json:"nonce"`
}

// Manifest is the authenticated plaintext container header. It carries no
// credential, no database URL and no owner private data beyond the deletion
// ledger digest; the ledger itself travels inside the encrypted export.
type Manifest struct {
	SchemaVersion      int       `json:"schemaVersion"`
	Label              string    `json:"label"`
	CreatedAt          time.Time `json:"createdAt"`
	DumpTool           string    `json:"dumpTool"`
	PlaintextBytes     int64     `json:"plaintextBytes"`
	PlaintextSHA256    string    `json:"plaintextSha256"`
	Cipher             Cipher    `json:"cipher"`
	TombstoneCount     int       `json:"tombstoneCount"`
	TombstoneLedgerSHA string    `json:"tombstoneLedgerSha256"`
	// RemovalCount is the number of online removals the bundle carries.
	RemovalCount int `json:"removalCount"`
	// RemovalLedgerSHA is the digest of the online removal ledger.
	RemovalLedgerSHA string `json:"removalLedgerSha256"`
	// SubjectRemovalCount is the number of subject level removals the bundle
	// carries.
	SubjectRemovalCount int `json:"subjectRemovalCount"`
	// SubjectRemovalLedgerSHA is the digest of the subject level removal
	// ledger.
	SubjectRemovalLedgerSHA string `json:"subjectRemovalLedgerSha256"`
	RestoredFrom            string `json:"restoredFromLabel,omitempty"`
}

func validatePassphrase(passphrase string) error {
	if len([]rune(passphrase)) < MinPassphraseLength {
		return fmt.Errorf("%w: at least %d characters are required", ErrPassphrase, MinPassphraseLength)
	}
	return nil
}

// Seal encrypts plaintext into a complete container:
//
//	magic | header length | manifest JSON | AES-256-GCM ciphertext | ciphertext SHA-256
//
// The manifest is the additional authenticated data, so a rewritten label,
// digest or rotation label cannot survive authentication. The sealed manifest
// is returned because Seal fills in the digests and cipher description that
// the caller reports.
func Seal(manifest Manifest, plaintext, passphrase []byte) ([]byte, Manifest, error) {
	if err := validatePassphrase(string(passphrase)); err != nil {
		return nil, Manifest{}, err
	}
	if len(plaintext) == 0 || len(plaintext) > MaxPlaintextBytes {
		return nil, Manifest{}, ErrTooLarge
	}
	if _, err := ParseLabel(manifest.Label); err != nil {
		return nil, Manifest{}, err
	}
	manifest.SchemaVersion = SchemaVersion
	manifest.PlaintextBytes = int64(len(plaintext))
	plainSum := sha256.Sum256(plaintext)
	manifest.PlaintextSHA256 = hex.EncodeToString(plainSum[:])

	salt := make([]byte, saltLength)
	nonce := make([]byte, nonceLength)
	if _, err := rand.Read(salt); err != nil {
		return nil, Manifest{}, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, Manifest{}, err
	}
	manifest.Cipher = Cipher{
		Algorithm:  algorithmKDF,
		KDF:        kdfName,
		Iterations: kdfIterations,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
	}
	header, err := json.Marshal(manifest)
	if err != nil {
		return nil, Manifest{}, err
	}
	gcm, err := newGCM(passphrase, manifest.Cipher)
	if err != nil {
		return nil, Manifest{}, err
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, buildAAD(header))
	cipherSum := sha256.Sum256(ciphertext)

	out := make([]byte, 0, headerPrefix+len(header)+len(ciphertext)+trailerSize)
	out = append(out, ContainerMagic...)
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	out = append(out, length[:]...)
	out = append(out, header...)
	out = append(out, ciphertext...)
	return append(out, cipherSum[:]...), manifest, nil
}

func buildAAD(header []byte) []byte {
	aad := make([]byte, 0, headerPrefix+len(header))
	aad = append(aad, ContainerMagic...)
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	aad = append(aad, length[:]...)
	return append(aad, header...)
}

func newGCM(passphrase []byte, spec Cipher) (cipher.AEAD, error) {
	if spec.Algorithm != algorithmKDF || spec.KDF != kdfName {
		return nil, fmt.Errorf("%w: unsupported cipher %q/%q", ErrUnsupportedVersion, spec.Algorithm, spec.KDF)
	}
	if spec.Iterations < 1000 || spec.Iterations > 10_000_000 {
		return nil, fmt.Errorf("%w: implausible iteration count %d", ErrMalformedContainer, spec.Iterations)
	}
	salt, err := base64.StdEncoding.DecodeString(spec.Salt)
	if err != nil || len(salt) != saltLength {
		return nil, ErrMalformedContainer
	}
	key, err := pbkdf2.Key(sha256.New, string(passphrase), salt, spec.Iterations, kdfKeyLength)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Open authenticates and decrypts a container. A returned error means the
// bundle is unusable; there is deliberately no partial-plaintext result.
func Open(container, passphrase []byte) (Manifest, []byte, error) {
	if len(container) < headerPrefix+trailerSize || string(container[:len(ContainerMagic)]) != ContainerMagic {
		return Manifest{}, nil, ErrMalformedContainer
	}
	headerLength := int(binary.BigEndian.Uint32(container[len(ContainerMagic):headerPrefix]))
	if headerLength <= 0 || headerPrefix+headerLength > len(container)-trailerSize {
		return Manifest{}, nil, ErrMalformedContainer
	}
	header := container[headerPrefix : headerPrefix+headerLength]
	var manifest Manifest
	if json.Unmarshal(header, &manifest) != nil {
		return Manifest{}, nil, ErrMalformedContainer
	}
	if manifest.SchemaVersion != SchemaVersion {
		return Manifest{}, nil, fmt.Errorf("%w: schemaVersion %d", ErrUnsupportedVersion, manifest.SchemaVersion)
	}
	ciphertext := container[headerPrefix+headerLength : len(container)-trailerSize]
	if len(ciphertext) == 0 || len(ciphertext) > MaxPlaintextBytes {
		return Manifest{}, nil, ErrTooLarge
	}
	expectedTrailer := container[len(container)-trailerSize:]
	actualTrailer := sha256.Sum256(ciphertext)
	if !equalBytes(expectedTrailer, actualTrailer[:]) {
		return Manifest{}, nil, fmt.Errorf("%w: ciphertext trailer", ErrDigestMismatch)
	}
	if err := validatePassphrase(string(passphrase)); err != nil {
		return Manifest{}, nil, err
	}
	gcm, err := newGCM(passphrase, manifest.Cipher)
	if err != nil {
		return Manifest{}, nil, err
	}
	nonce, err := base64.StdEncoding.DecodeString(manifest.Cipher.Nonce)
	if err != nil || len(nonce) != nonceLength {
		return Manifest{}, nil, ErrMalformedContainer
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, buildAAD(header))
	if err != nil {
		return Manifest{}, nil, fmt.Errorf("%w: %v", ErrPassphrase, err)
	}
	plainSum := sha256.Sum256(plaintext)
	if manifest.PlaintextSHA256 != hex.EncodeToString(plainSum[:]) || manifest.PlaintextBytes != int64(len(plaintext)) {
		return Manifest{}, nil, fmt.Errorf("%w: plaintext", ErrDigestMismatch)
	}
	return manifest, plaintext, nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var difference byte
	for i := range a {
		difference |= a[i] ^ b[i]
	}
	return difference == 0
}

// ReadContainer loads a container from disk with an explicit size bound.
func ReadContainer(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: %s is not a regular file", ErrMalformedContainer, path)
	}
	if info.Size() > MaxPlaintextBytes+trailerSize {
		return nil, ErrTooLarge
	}
	return io.ReadAll(io.LimitReader(file, MaxPlaintextBytes+trailerSize))
}

// ReadManifest reads only the authenticated plaintext header of a container. It
// performs no key derivation, so rotation can label and date bundles, and an
// operator can inspect how a bundle was sealed, before a passphrase exists.
func ReadManifest(path string) (Manifest, error) {
	container, err := ReadContainer(path)
	if err != nil {
		return Manifest{}, err
	}
	if len(container) < headerPrefix+trailerSize || string(container[:len(ContainerMagic)]) != ContainerMagic {
		return Manifest{}, ErrMalformedContainer
	}
	headerLength := int(binary.BigEndian.Uint32(container[len(ContainerMagic):headerPrefix]))
	if headerLength <= 0 || headerPrefix+headerLength > len(container)-trailerSize {
		return Manifest{}, ErrMalformedContainer
	}
	var manifest Manifest
	if json.Unmarshal(container[headerPrefix:headerPrefix+headerLength], &manifest) != nil {
		return Manifest{}, ErrMalformedContainer
	}
	if manifest.SchemaVersion != SchemaVersion {
		return Manifest{}, fmt.Errorf("%w: schemaVersion %d", ErrUnsupportedVersion, manifest.SchemaVersion)
	}
	return manifest, nil
}

// EncodeLedger renders a deletion ledger to its canonical digest input. The
// order is sorted by game ID so two operators sealing the same deletions
// produce the same digest.
func EncodeLedger(tombstones []Tombstone) ([]byte, error) {
	sorted := append([]Tombstone(nil), tombstones...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].GameID < sorted[j].GameID })
	return json.Marshal(sorted)
}

func digestHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
