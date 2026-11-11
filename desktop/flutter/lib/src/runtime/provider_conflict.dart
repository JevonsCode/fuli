/// A start the core refused because this computer's graph service was set up
/// by a newer FULI than the one starting it. The core's error text begins with
/// `provider_downgrade_refused installed=<version> required=<version>`
/// (src/native-runtime/runtime.js); it reaches every runtime as text.
class ProviderConflict {
  const ProviderConflict({required this.installed, required this.required});

  /// What set up the graph service on this computer, and what this FULI brings.
  final String installed;
  final String required;

  static final _pattern = RegExp(r'provider_downgrade_refused installed=([0-9A-Za-z.+-]+) required=([0-9A-Za-z.+-]+)');

  static ProviderConflict? parse(String error) {
    final match = _pattern.firstMatch(error);
    return match == null ? null : ProviderConflict(installed: match.group(1)!, required: match.group(2)!);
  }

  /// The two versions as a person compares them: the `+native.N` repair number
  /// shows only when it is the whole difference.
  ({String installed, String current}) get shown {
    String plain(String version) => version.split('+').first;
    return plain(installed) == plain(required)
        ? (installed: installed, current: required)
        : (installed: plain(installed), current: plain(required));
  }
}
