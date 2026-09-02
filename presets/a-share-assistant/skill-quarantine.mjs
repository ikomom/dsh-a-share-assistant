/**
 * skill-quarantine: 永久屏蔽技能目录（skill-catalog 消息源），实现"纯净技能"。
 *
 * DSH 在 agent/pre-step 以 source.kind='skill-catalog' 的 user-role 消息注入
 * `<available_skills>` 目录（合并全局层 + 预设层）。本插件在进入步骤前无条件
 * 过滤该来源，使技能目录不进上下文——宿主平台的全局技能（agent-browser 等）
 * 自然不可见、不可调用。
 *
 * 本预设的唯一技能 a-share-assistant 仍注册在技能注册表（skill-filesystem），
 * AI 可按名称加载；persona 同时给出 SKILL.md 绝对路径，可绕过目录直接 read。
 *
 * 结构参照 liangshen/tool-bootstrap.mjs（MIT）的 pre-step 过滤手法。
 */

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'skill-quarantine'

/** 只挂钩 pre-step，无其他依赖。 */
export const inject = []

/** 需要屏蔽的消息源 kind。 */
const QUARANTINED_SOURCES = new Set(['skill-catalog'])

/** 是否属于被屏蔽的注入消息。 */
function isQuarantined(message) {
  const kind = message.source?.kind
  return kind !== undefined && QUARANTINED_SOURCES.has(kind)
}

/** 注册过滤：任何进入步骤的批次，先去掉技能目录消息，再放行。 */
export function apply(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages?.filter(message => !isQuarantined(message))
    return { ...decision, messages }
  })
}