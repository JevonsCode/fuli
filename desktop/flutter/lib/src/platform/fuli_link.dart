// A `fuli://` link: FULI's own address for a console page, independent of
// the port the console listens on now. It only navigates. `fuli://status`
// (or nothing after `fuli://`) is the client's own window; `fuli://<path>?<query>`
// is `http://127.0.0.1:<console port>/<path>?<query>`. Anything else is
// refused: other hosts, ports, user info, fragments, `.` and `..` segments
// (raw or percent-encoded), encoded slashes and backslashes, and characters
// outside plain ASCII URL text.

// The launcher (desktop/windows/FuliLauncher.cs) refuses longer links too.
const maxFuliLinkLength = 2048;

const _consoleHost = '127.0.0.1';
const _statusPath = 'status';
const _pchar = r"(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
// fuli://<first segment><more segments>?<query>; the first segment stands
// where a host would, so it is a plain word.
final _shape = RegExp('^[Ff][Uu][Ll][Ii]://([A-Za-z0-9-]*)((?:/$_pchar*)*)(?:\\?((?:$_pchar|[/?])*))?\$');
final _unsafeSegment = RegExp(r'[/\\\x00-\x1f\x7f]');

class FuliLink {
  const FuliLink._(this.text, this.segments, this.query);

  /// The link as it was given.
  final String text;

  /// The console path, one decoded segment each.
  final List<String> segments;
  final String? query;

  /// The link [text] names, or null when it is not a plain `fuli://` link.
  static FuliLink? parse(String text) {
    if (text.length > maxFuliLinkLength) return null;
    final match = _shape.firstMatch(text);
    if (match == null) return null;
    final raw = [if (match.group(1)!.isNotEmpty) match.group(1)!, ...match.group(2)!.split('/').skip(1)];
    if (raw.isNotEmpty && raw.last.isEmpty) raw.removeLast(); // one trailing slash
    final segments = <String>[];
    for (final segment in raw) {
      final String decoded;
      try {
        decoded = Uri.decodeComponent(segment);
      } on FormatException {
        return null; // not UTF-8
      }
      if (decoded.isEmpty || decoded == '.' || decoded == '..' || _unsafeSegment.hasMatch(decoded)) return null;
      segments.add(decoded);
    }
    return FuliLink._(text, List.unmodifiable(segments), match.group(3));
  }

  /// Whether the link asks for the client's own window instead of a console page.
  bool get opensClient => segments.isEmpty || (segments.length == 1 && segments.single == _statusPath);

  /// The console page this link names while the console listens on [port].
  Uri consolePage(int port) =>
      Uri(scheme: 'http', host: _consoleHost, port: port, pathSegments: segments, query: query?.isEmpty == true ? null : query);
}
