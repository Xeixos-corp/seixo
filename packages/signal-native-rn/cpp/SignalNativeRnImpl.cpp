#include "SignalNativeRnImpl.h"

namespace facebook::react {

SignalNativeRnImpl::SignalNativeRnImpl(
  std::shared_ptr<CallInvoker> jsInvoker
)
  : NativeSignalNativeRnCxxSpec(std::move(jsInvoker)) {}

double SignalNativeRnImpl::multiply(
  jsi::Runtime& rt,
  double a,
  double b
) {
  return a * b;
}

}
