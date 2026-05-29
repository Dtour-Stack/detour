/**
 * Nightly-recap pop-up. On app open, pulls the open questions the agent
 * couldn't answer (set "pending" by the recap job that ran while the app was
 * closed) and shows them with inline answer boxes. Each answer is sent over
 * typed RPC → ingested as knowledge so the agent learns it. Talks ONLY via
 * `rpc.request.*` — no bun imports, no other-feature imports.
 */
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../rpc";
import type { OpenQuestion } from "../../shared/rpc/recap";

export function RecapPopup() {
	const [questions, setQuestions] = useState<OpenQuestion[]>([]);
	const [show, setShow] = useState(false);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});

	useEffect(() => {
		let cancelled = false;
		void rpc.request
			.getOpenQuestions({})
			.then((res: { questions: OpenQuestion[]; pendingRecap: boolean }) => {
				if (cancelled) return;
				if (res.pendingRecap && res.questions.length > 0) {
					setQuestions(res.questions);
					setShow(true);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const close = useCallback(() => {
		void rpc.request.acknowledgeRecap({}).catch(() => {});
		setShow(false);
	}, []);

	const submit = useCallback(
		async (id: string) => {
			const answer = (answers[id] ?? "").trim();
			if (!answer) return;
			setBusy((b) => ({ ...b, [id]: true }));
			try {
				const res = await rpc.request.answerOpenQuestion({ id, answer });
				if (res.ok) {
					setQuestions((qs) => {
						const next = qs.filter((q) => q.id !== id);
						if (next.length === 0) close();
						return next;
					});
				}
			} finally {
				setBusy((b) => ({ ...b, [id]: false }));
			}
		},
		[answers, close],
	);

	if (!show || questions.length === 0) return null;

	return (
		<div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Nightly recap">
			<div style={cardStyle}>
				<div style={headerStyle}>
					<strong>Detour Squirrel — nightly recap</strong>
					<button style={closeBtnStyle} onClick={close} aria-label="Close">×</button>
				</div>
				<p style={subStyle}>
					{questions.length} question{questions.length === 1 ? "" : "s"} he couldn't answer or look up. Answer
					them and he'll learn for next time.
				</p>
				<div style={listStyle}>
					{questions.map((q) => (
						<div key={q.id} style={itemStyle}>
							<div style={qTextStyle}>{q.question}</div>
							{q.context ? <div style={ctxStyle}>{q.context}</div> : null}
							<textarea
								style={inputStyle}
								placeholder="Your answer…"
								value={answers[q.id] ?? ""}
								onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
								rows={2}
							/>
							<div style={rowStyle}>
								<button
									style={submitBtnStyle}
									disabled={busy[q.id] || !(answers[q.id] ?? "").trim()}
									onClick={() => void submit(q.id)}
								>
									{busy[q.id] ? "Saving…" : "Teach him"}
								</button>
								<button
									style={skipBtnStyle}
									onClick={() => void rpc.request.dismissOpenQuestion({ id: q.id }).then(() => setQuestions((qs) => qs.filter((x) => x.id !== q.id)))}
								>
									Dismiss
								</button>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

const overlayStyle: React.CSSProperties = {
	position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex",
	alignItems: "center", justifyContent: "center", zIndex: 9999,
};
const cardStyle: React.CSSProperties = {
	width: "min(560px, 92vw)", maxHeight: "82vh", overflowY: "auto", background: "#15161a",
	color: "#e8e8ea", border: "1px solid #2a2c33", borderRadius: 12, padding: 18,
	boxShadow: "0 20px 60px rgba(0,0,0,0.5)", fontSize: 14,
};
const headerStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 };
const closeBtnStyle: React.CSSProperties = { background: "none", border: "none", color: "#9a9ca5", fontSize: 22, cursor: "pointer", lineHeight: 1 };
const subStyle: React.CSSProperties = { color: "#9a9ca5", margin: "0 0 12px" };
const listStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 14 };
const itemStyle: React.CSSProperties = { borderTop: "1px solid #2a2c33", paddingTop: 12 };
const qTextStyle: React.CSSProperties = { fontWeight: 600, marginBottom: 2 };
const ctxStyle: React.CSSProperties = { color: "#7c7e87", fontSize: 12, marginBottom: 6 };
const inputStyle: React.CSSProperties = {
	width: "100%", background: "#0e0f12", color: "#e8e8ea", border: "1px solid #2a2c33",
	borderRadius: 8, padding: "8px 10px", resize: "vertical", fontFamily: "inherit", fontSize: 13,
};
const rowStyle: React.CSSProperties = { display: "flex", gap: 8, marginTop: 8 };
const submitBtnStyle: React.CSSProperties = {
	background: "#5b8cff", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontWeight: 600,
};
const skipBtnStyle: React.CSSProperties = {
	background: "transparent", color: "#9a9ca5", border: "1px solid #2a2c33", borderRadius: 8, padding: "7px 12px", cursor: "pointer",
};
