import type { SessionSummary, SessionViewState } from "../dto/types.js";
export declare const SESSION_SWITCH_NOTE = "\u672C\u5730\u53EA\u8BFB\u67E5\u770B\u6210\u7EE9\u5355\u6240\u7528\u7684\u4F1A\u8BDD\u9009\u62E9\uFF0C\u4E0D\u662F\u5B98\u65B9\u4F1A\u8BDD\u5207\u6362\u5199\u64CD\u4F5C\u3002\u8BE5\u80FD\u529B\u9700\u5355\u72EC\u9A8C\u6536\uFF1B\u6570\u636E\u4E0D\u8DB3\u4EE5\u5B89\u5168\u5207\u6362\u65F6\u53EA\u5C55\u793A\u5217\u8868\u4E0E\u5F53\u524D\u4F1A\u8BDD\u3002";
export declare function presentSessionView(opts: {
    sessions: SessionSummary[];
    statusSessionId?: string;
    viewerSessionId?: string;
    requestedViewId?: string;
}): SessionViewState;
