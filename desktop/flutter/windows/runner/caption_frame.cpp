#include "caption_frame.h"

#include <commctrl.h>
#include <flutter/standard_method_codec.h>
#include <windowsx.h>

#include <cmath>

namespace {

constexpr UINT_PTR kViewSubclassId = 1;

double ArgumentOf(const flutter::EncodableMap& arguments, const char* name) {
  return std::get<double>(arguments.at(flutter::EncodableValue(name)));
}

}  // namespace

CaptionFrame::CaptionFrame(HWND window, HWND view,
                           flutter::BinaryMessenger* messenger)
    : window_(window), view_(view) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "fuli/caption",
      &flutter::StandardMethodCodec::GetInstance());
  channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        if (call.method_name() != "placeMaximizeButton") {
          result->NotImplemented();
          return;
        }
        const auto& arguments =
            std::get<flutter::EncodableMap>(*call.arguments());
        button_ = Placement{ArgumentOf(arguments, "right"),
                            ArgumentOf(arguments, "top"),
                            ArgumentOf(arguments, "width"),
                            ArgumentOf(arguments, "height")};
        result->Success();
      });
  SetWindowSubclass(view_, ViewProc, kViewSubclassId,
                    reinterpret_cast<DWORD_PTR>(this));
}

CaptionFrame::~CaptionFrame() {
  RemoveWindowSubclass(view_, ViewProc, kViewSubclassId);
  channel_->SetMethodCallHandler(nullptr);
}

LRESULT CALLBACK CaptionFrame::ViewProc(HWND view, UINT message, WPARAM wparam,
                                        LPARAM lparam, UINT_PTR,
                                        DWORD_PTR self) {
  if (message == WM_NCHITTEST &&
      reinterpret_cast<CaptionFrame*>(self)->HitTest(
          {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)}) != HTNOWHERE) {
    return HTTRANSPARENT;
  }
  return DefSubclassProc(view, message, wparam, lparam);
}

LRESULT CaptionFrame::HitTest(POINT screen) const {
  POINT point = screen;
  ScreenToClient(window_, &point);
  RECT client;
  GetClientRect(window_, &client);
  const UINT dpi = GetDpiForWindow(window_);
  // As deep as the hidden caption's resize edge; none while maximised.
  const int edge = GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) +
                   GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
  if (!IsZoomed(window_) && point.y >= 0 && point.y < edge) {
    if (point.x < edge) return HTTOPLEFT;
    if (point.x >= client.right - edge) return HTTOPRIGHT;
    return HTTOP;
  }
  if (button_) {
    const double scale = dpi / 96.0;
    const LONG right = client.right - std::lround(button_->right * scale);
    const LONG left = right - std::lround(button_->width * scale);
    const LONG top = std::lround(button_->top * scale);
    const LONG bottom = top + std::lround(button_->height * scale);
    if (point.x >= left && point.x < right && point.y >= top &&
        point.y < bottom) {
      return HTMAXBUTTON;
    }
  }
  return HTNOWHERE;
}

std::optional<LRESULT> CaptionFrame::HandleMessage(UINT message, WPARAM wparam,
                                                   LPARAM lparam) {
  switch (message) {
    case WM_NCHITTEST: {
      const LRESULT hit = HitTest({GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)});
      if (hit != HTNOWHERE) return hit;
      break;
    }
    // The button's hover, press and click are the client's to paint and do;
    // DefWindowProc would draw the hidden caption's buttons over the strip.
    case WM_NCMOUSEMOVE:
      if (wparam == HTMAXBUTTON) {
        TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE | TME_NONCLIENT,
                              window_, 0};
        TrackMouseEvent(&track);
        if (button_state_ == "idle") SetButtonState("hovered");
        return 0;
      }
      SetButtonState("idle");
      break;
    case WM_NCMOUSELEAVE:
      SetButtonState("idle");
      break;
    case WM_NCLBUTTONDOWN:
    case WM_NCLBUTTONDBLCLK:
      if (wparam == HTMAXBUTTON) {
        SetButtonState("pressed");
        return 0;
      }
      break;
    case WM_NCLBUTTONUP:
      if (wparam == HTMAXBUTTON) {
        const bool pressed = button_state_ == "pressed";
        SetButtonState("hovered");
        if (pressed) {
          SendMessage(window_, WM_SYSCOMMAND,
                      IsZoomed(window_) ? SC_RESTORE : SC_MAXIMIZE, 0);
        }
        return 0;
      }
      break;
  }
  return std::nullopt;
}

void CaptionFrame::SetButtonState(const std::string& state) {
  if (state == button_state_) return;
  button_state_ = state;
  channel_->InvokeMethod("maximizeButton",
                         std::make_unique<flutter::EncodableValue>(state));
}
