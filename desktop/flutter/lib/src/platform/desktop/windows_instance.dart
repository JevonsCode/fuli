import 'dart:async';
import 'dart:ffi';
import 'dart:io' show sleep;

import 'package:ffi/ffi.dart';

// One client per Windows user and data directory, and the signals updates
// send it. The names are the ones FuliTray.exe used, so updates and older
// versions on either side find each other (src/desktop/windows-update-lock.js):
// the mutex `Global\FuliTray-<user SID>-<instanceKey>`, held while the client
// runs; `<name>-open`, set by a second launch to show this client's window or
// to say that its fuli:// link waits in the client's inbox (link_inbox.dart);
// `<name>-exit`, set by an update to close this client. The events carry no
// payload, so they stay the same for every version.

const _waitObject0 = 0;
const _waitAbandoned = 0x80;
const _eventModifyState = 0x0002;
const _tokenQuery = 0x0008;
const _tokenUser = 1;
// A second launch hands its request to the running client; the client may
// still be creating its events.
const _handOverAttempts = 40;
const _handOverPause = Duration(milliseconds: 50);
const _signalPoll = Duration(milliseconds: 500);

final _kernel32 = DynamicLibrary.open('kernel32.dll');
final _advapi32 = DynamicLibrary.open('advapi32.dll');

final _createMutex = _kernel32.lookupFunction<IntPtr Function(Pointer, Int32, Pointer<Utf16>), int Function(Pointer, int, Pointer<Utf16>)>('CreateMutexW');
final _releaseMutex = _kernel32.lookupFunction<Int32 Function(IntPtr), int Function(int)>('ReleaseMutex');
final _createEvent = _kernel32
    .lookupFunction<IntPtr Function(Pointer, Int32, Int32, Pointer<Utf16>), int Function(Pointer, int, int, Pointer<Utf16>)>('CreateEventW');
final _openEvent = _kernel32.lookupFunction<IntPtr Function(Uint32, Int32, Pointer<Utf16>), int Function(int, int, Pointer<Utf16>)>('OpenEventW');
final _setEvent = _kernel32.lookupFunction<Int32 Function(IntPtr), int Function(int)>('SetEvent');
final _waitFor = _kernel32.lookupFunction<Uint32 Function(IntPtr, Uint32), int Function(int, int)>('WaitForSingleObject');
final _closeHandle = _kernel32.lookupFunction<Int32 Function(IntPtr), int Function(int)>('CloseHandle');
final _currentProcess = _kernel32.lookupFunction<IntPtr Function(), int Function()>('GetCurrentProcess');
final _localFree = _kernel32.lookupFunction<IntPtr Function(Pointer), int Function(Pointer)>('LocalFree');
final _openProcessToken =
    _advapi32.lookupFunction<Int32 Function(IntPtr, Uint32, Pointer<IntPtr>), int Function(int, int, Pointer<IntPtr>)>('OpenProcessToken');
final _tokenInformation = _advapi32.lookupFunction<Int32 Function(IntPtr, Int32, Pointer, Uint32, Pointer<Uint32>),
    int Function(int, int, Pointer, int, Pointer<Uint32>)>('GetTokenInformation');
final _sidToString = _advapi32
    .lookupFunction<Int32 Function(Pointer, Pointer<Pointer<Utf16>>), int Function(Pointer, Pointer<Pointer<Utf16>>)>('ConvertSidToStringSidW');

/// What a launch found: this client now owns the lock, it handed its request
/// to the client that does, or the lock is held by someone that takes no
/// requests (an update in progress).
enum InstanceClaim { owner, handedOver, held }

class WindowsInstance {
  WindowsInstance._(this._mutex, this._open, this._exit);

  final int _mutex;
  final int _open;
  final int _exit;
  Timer? _poll;

  /// Takes the lock of [instanceKey] (windows-controller.js `context`), or,
  /// with [handOver], signals the client that holds it (its window, or a
  /// link left in its inbox).
  static (InstanceClaim, WindowsInstance?) claim(String instanceKey, {bool handOver = true}) => using((arena) {
        final name = 'Global\\FuliTray-${_userSid()}-$instanceKey';
        final mutex = _createMutex(nullptr, 0, name.toNativeUtf16(allocator: arena));
        if (mutex == 0) return (InstanceClaim.held, null);
        final wait = _waitFor(mutex, 0);
        if (wait == _waitObject0 || wait == _waitAbandoned) {
          final open = _createEvent(nullptr, 0, 0, '$name-open'.toNativeUtf16(allocator: arena));
          final exit = _createEvent(nullptr, 0, 0, '$name-exit'.toNativeUtf16(allocator: arena));
          return (InstanceClaim.owner, WindowsInstance._(mutex, open, exit));
        }
        _closeHandle(mutex);
        if (!handOver) return (InstanceClaim.held, null);
        return (_handOver('$name-open'.toNativeUtf16(allocator: arena)), null);
      });

  /// Calls [onOpen] when a second launch signals and [onExit]
  /// when an update asks this client to close.
  void listen({required void Function() onOpen, required void Function() onExit}) {
    _poll?.cancel();
    _poll = Timer.periodic(_signalPoll, (_) {
      if (_open != 0 && _waitFor(_open, 0) == _waitObject0) onOpen();
      if (_exit != 0 && _waitFor(_exit, 0) == _waitObject0) onExit();
    });
  }

  /// Gives the lock back; the process exiting does the same.
  void release() {
    _poll?.cancel();
    for (final handle in [_open, _exit]) {
      if (handle != 0) _closeHandle(handle);
    }
    _releaseMutex(_mutex);
    _closeHandle(_mutex);
  }

  static InstanceClaim _handOver(Pointer<Utf16> openName) {
    for (var attempt = 0; attempt < _handOverAttempts; attempt++) {
      final event = _openEvent(_eventModifyState, 0, openName);
      if (event != 0) {
        _setEvent(event);
        _closeHandle(event);
        return InstanceClaim.handedOver;
      }
      sleep(_handOverPause);
    }
    return InstanceClaim.held;
  }

  // The current user's SID as text (S-1-5-21-…), as .NET's WindowsIdentity reports it.
  static String _userSid() => using((arena) {
        final token = arena<IntPtr>();
        if (_openProcessToken(_currentProcess(), _tokenQuery, token) == 0) throw StateError('OpenProcessToken failed.');
        try {
          final size = arena<Uint32>();
          _tokenInformation(token.value, _tokenUser, nullptr, 0, size);
          final buffer = arena<Uint8>(size.value);
          if (_tokenInformation(token.value, _tokenUser, buffer, size.value, size) == 0) {
            throw StateError('GetTokenInformation failed.');
          }
          // TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first field is the SID pointer.
          final sid = buffer.cast<Pointer>().value;
          final text = arena<Pointer<Utf16>>();
          if (_sidToString(sid, text) == 0) throw StateError('ConvertSidToStringSid failed.');
          try {
            return text.value.toDartString();
          } finally {
            _localFree(text.value);
          }
        } finally {
          _closeHandle(token.value);
        }
      });
}
