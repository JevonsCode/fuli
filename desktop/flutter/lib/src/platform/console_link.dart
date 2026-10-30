/// Whether [url] is a page of the console at [console] (same scheme, host and
/// port). Those stay in the window; every other link opens in the browser.
bool isConsolePage(Uri url, Uri console) =>
    url.scheme == console.scheme && url.host == console.host && url.port == console.port;
