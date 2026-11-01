#ifndef RUNNER_CAPTION_FRAME_H_
#define RUNNER_CAPTION_FRAME_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <memory>
#include <optional>
#include <string>

// The client draws its own window buttons (lib/src/ui/window_caption.dart) in
// a window whose title bar window_manager hides. Two parts of the hidden caption
// stay with the OS:
// - the drawn maximise button is the OS's maximise button to hit testing, so
//   hovering it opens Windows 11's snap layouts and clicking it maximises or
//   restores the window as the native button did;
// - the window's top edge still resizes it.
// The Flutter view lets the pointer through there (HTTRANSPARENT) and the
// top-level window answers instead. lib/src/platform/desktop/desktop_caption.dart
// says where the button is and paints the hover and press reported back.
class CaptionFrame {
 public:
  CaptionFrame(HWND window, HWND view, flutter::BinaryMessenger* messenger);
  ~CaptionFrame();

  CaptionFrame(const CaptionFrame&) = delete;
  CaptionFrame& operator=(const CaptionFrame&) = delete;

  // The top-level window's messages, before DefWindowProc.
  std::optional<LRESULT> HandleMessage(UINT message, WPARAM wparam,
                                       LPARAM lparam);

 private:
  // In logical pixels, from the client area's top right.
  struct Placement {
    double right;
    double top;
    double width;
    double height;
  };

  static LRESULT CALLBACK ViewProc(HWND view, UINT message, WPARAM wparam,
                                   LPARAM lparam, UINT_PTR id,
                                   DWORD_PTR self);

  // HTMAXBUTTON, a top resize edge, or HTNOWHERE where the client handles
  // the pointer itself.
  LRESULT HitTest(POINT screen) const;
  void SetButtonState(const std::string& state);

  HWND window_;
  HWND view_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  std::optional<Placement> button_;
  std::string button_state_ = "idle";
};

#endif  // RUNNER_CAPTION_FRAME_H_
