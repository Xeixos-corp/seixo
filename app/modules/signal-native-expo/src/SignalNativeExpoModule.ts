import { NativeModule, requireNativeModule } from 'expo';
import type { EncryptedEnvelope, OneTimePrekeyPublic, PreKeyBundleData } from './SignalNativeExpo.types';

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
  establishSession(remoteUserId: string, remoteDeviceId: number, bundle: PreKeyBundleData): void;
  encrypt(remoteUserId: string, remoteDeviceId: number, plaintext: string): EncryptedEnvelope;
  decrypt(remoteUserId: string, remoteDeviceId: number, envelope: EncryptedEnvelope): string;
}

export default requireNativeModule<SignalNativeExpoModule>('SignalNativeExpo');
