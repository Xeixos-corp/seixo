#pragma once

#include <SignalNativeRnSpecJSI.h>

#include <memory>

namespace facebook::react {

class SignalNativeRnImpl
  : public NativeSignalNativeRnCxxSpec<SignalNativeRnImpl> {
public:
  SignalNativeRnImpl(std::shared_ptr<CallInvoker> jsInvoker);

  double multiply(jsi::Runtime& rt, double a, double b);
};

}
