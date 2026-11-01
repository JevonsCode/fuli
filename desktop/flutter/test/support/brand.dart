import 'dart:convert';
import 'dart:io';

import 'package:fuli_desktop/src/ui/brand.dart';

/// The brand from test/fixtures/fuli-mark.json: the same contract as
/// assets/brand/fuli-mark.json, built from the brand's mark SVGs.
final testBrand = FuliBrand.fromJson(
    jsonDecode(File('test/fixtures/fuli-mark.json').readAsStringSync()) as Map<String, Object?>);
