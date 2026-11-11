export const SESSION_SWITCH_NOTE = "本地只读查看成绩单所用的会话选择，不是官方会话切换写操作。该能力需单独验收；数据不足以安全切换时只展示列表与当前会话。";
export function presentSessionView(opts) {
    const ids = new Set(opts.sessions.map((s) => s.session_id).filter(Boolean));
    let current_session_id;
    let current_session_source = "none";
    if (opts.statusSessionId && ids.has(opts.statusSessionId)) {
        current_session_id = opts.statusSessionId;
        current_session_source = "status";
    }
    else if (opts.viewerSessionId && ids.has(opts.viewerSessionId)) {
        current_session_id = opts.viewerSessionId;
        current_session_source = "viewer_session";
    }
    const view = {
        current_session_source,
        switch_available: ids.size > 0,
        note: SESSION_SWITCH_NOTE,
    };
    if (current_session_id)
        view.current_session_id = current_session_id;
    if (opts.requestedViewId) {
        if (ids.has(opts.requestedViewId)) {
            view.viewed_session_id = opts.requestedViewId;
        }
        else {
            view.switch_error = "会话不在当前列表中，未切换。";
            if (current_session_id)
                view.viewed_session_id = current_session_id;
        }
    }
    else if (current_session_id) {
        view.viewed_session_id = current_session_id;
    }
    return view;
}
