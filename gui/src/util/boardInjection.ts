import { BoardMessage, BoardPendingResult, RuleWithSource } from "core";

// Board auto-topic-injection (board-auto-topic-injection.md): rendering of
// consumed board messages into a system-message block. The block participates
// as an always-apply rule, exactly like AGENTS.md.

export function renderBoardInjectionBlock(
  result: BoardPendingResult,
  fetchedAt: Date = new Date(),
): string {
  const byTopic = new Map<string, BoardMessage[]>();
  for (const message of result.messages) {
    const list = byTopic.get(message.topic) ?? [];
    list.push(message);
    byTopic.set(message.topic, list);
  }

  const sections: string[] = [
    `# MsgBoard — neue Nachrichten (Stand: ${fetchedAt.toISOString()})`,
  ];
  for (const [topic, messages] of byTopic) {
    sections.push(`\n## Topic: ${topic}`);
    for (const message of messages) {
      const re = message.re !== undefined ? ` · re: #${message.re}` : "";
      sections.push(
        `\n_[cittmsg] id ${message.id} · from: ${message.from} → to: ${message.to}${re} · ${message.createdAt}_\n\n${message.body}`,
      );
    }
  }
  if (result.omitted && result.omitted.count > 0) {
    sections.push(
      `\n_${result.omitted.count} weitere Nachrichten (älter als #${result.omitted.oldestOmittedId}) wurden nicht injiziert — bei Bedarf per msg_list/msg_read nachladen._`,
    );
  }
  if (result.warning) {
    sections.push(`\n_Warning vom Board: ${result.warning}_`);
  }
  return sections.join("\n");
}

export const BOARD_INJECTION_RULE_NAME = "MsgBoard Injection";

export function boardInjectionRule(block: string): RuleWithSource {
  return {
    name: BOARD_INJECTION_RULE_NAME,
    rule: block,
    source: "board",
    alwaysApply: true,
  };
}
