import 'dart:io';

/// An in-memory registry behind a fake reg.exe; the real HKCU is never read
/// or written. Values are `<key>|<name>`; a key's default value (`/ve`) has
/// an empty name and is listed under a localized name, as Windows does.
class FakeRegistry {
  FakeRegistry({this.defaultName = '(Default)'});

  final String defaultName;
  final Map<String, (String, String)> values = {};
  final List<List<String>> calls = [];

  Future<ProcessResult> call(List<String> args) async {
    calls.add(args);
    final key = args[1];
    final name = args.contains('/ve') ? '' : args[args.indexOf('/v') + 1];
    final id = '$key|$name';
    switch (args.first) {
      case 'query':
        final value = values[id];
        if (value == null) return ProcessResult(0, 1, '', 'ERROR: The system was unable to find the specified registry key or value.');
        final shown = name.isEmpty ? defaultName : name;
        return ProcessResult(0, 0, '\r\n$key\r\n    $shown    ${value.$1}    ${value.$2}\r\n\r\n', '');
      case 'add':
        final type = args[args.indexOf('/t') + 1];
        final data = args[args.indexOf('/d') + 1];
        values[id] = (type, type == 'REG_DWORD' ? '0x${int.parse(data).toRadixString(16)}' : data);
        return ProcessResult(0, 0, 'The operation completed successfully.', '');
      case 'delete':
        values.remove(id);
        return ProcessResult(0, 0, 'The operation completed successfully.', '');
    }
    return ProcessResult(0, 1, '', 'unsupported');
  }
}
