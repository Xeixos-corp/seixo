import { registerWebModule, NativeModule } from 'expo';

// SignalNativeExpoModule is not available on the web platform.
class SignalNativeExpoModule extends NativeModule<{}> {}

export default registerWebModule(SignalNativeExpoModule);
