import 'dart:convert';
import 'dart:io';

import 'package:fuli_desktop/src/ui/brand.dart';

Map<String, Object?> _fixture(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync()) as Map<String, Object?>;

/// The brand from test/fixtures/fuli-mark.json and fuli-wordmark.json: the same
/// contracts as assets/brand/, generated from the brand's mark and wordmark SVGs.
final testBrand = FuliBrand.fromJson(_fixture('fuli-mark.json'), _fixture('fuli-wordmark.json'));
