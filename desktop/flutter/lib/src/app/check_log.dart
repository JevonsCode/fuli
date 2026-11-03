/// Where the client notes each check of FULI that went wrong: when, which
/// kind (doctor-timeout, unreachable, http-NNN, unreadable, health) and the
/// transport's own short reason. Never a request or response body, a token
/// or a task context: a record of what failed when, so a recurring
/// 「控制台没有应答」 can be told apart afterwards (rec#70).
abstract class CheckLog {
  void failed(DateTime at, String kind, String reason);
}

class SilentCheckLog implements CheckLog {
  const SilentCheckLog();

  @override
  void failed(DateTime at, String kind, String reason) {}
}
