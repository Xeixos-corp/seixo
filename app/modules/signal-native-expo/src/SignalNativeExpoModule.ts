import { NativeModule, requireNativeModule } from 'expo';
import type {
  EncryptedEnvelope,
  OneTimePrekeyPublic,
  PreKeyBundleData,
  RotatedPrekeys,
  BackupCredentials,
} from './SignalNativeExpo.types';

declare class SignalNativeExpoModule extends NativeModule<{}> {
  createDevice(userId: string, deviceId: number, masterKeyBase64: string): void;
  wipeLocalStore(): void;
  identityPublicKeyBase64(): string;
  generatePrekeyBundle(
    oneTimePrekeyId: number,
    signedPrekeyId: number,
    kyberPrekeyId: number,
  ): PreKeyBundleData;
  generateExtraOneTimePrekeys(ids: number[]): OneTimePrekeyPublic[];
  rotateSignedPrekeys(signedPrekeyId: number, kyberPrekeyId: number): RotatedPrekeys;
  prunePrekeys(keepSignedIds: number[], keepKyberIds: number[]): void;
  safetyNumber(remoteUserId: string, remoteIdentityKeyBase64: string): string;
  forgetPeerIdentity(remoteUserId: string, remoteDeviceId: number): void;
  establishSession(remoteUserId: string, remoteDeviceId: number, bundle: PreKeyBundleData): void;
  encrypt(remoteUserId: string, remoteDeviceId: number, plaintext: string): EncryptedEnvelope;
  decrypt(remoteUserId: string, remoteDeviceId: number, envelope: EncryptedEnvelope): string;

  // --- Recovery backups (packages/signal-native/rust/src/backup.rs) ---
  // Note the shape: the identity's private half never crosses into JS. It is
  // read and sealed inside createRecoveryBackup, so the most dangerous value
  // in the app exists only in native memory.
  createRecoveryBackup(phrase: string, contentsJson: string): string;
  readRecoveryBackup(phrase: string, blob: string): string;
  restoreIdentityFromBackup(
    identityKeyPairBase64: string,
    registrationId: number,
    masterKeyBase64: string,
  ): void;
  generateRecoveryPhrase(): string;
  isValidRecoveryPhrase(phrase: string): boolean;
  deriveBackupCredentials(phrase: string): BackupCredentials;
}

export default requireNativeModule<SignalNativeExpoModule>('SignalNativeExpo');
