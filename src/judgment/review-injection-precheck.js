// The host's deterministic injection pre-check of a knowledge review
// candidate (rec#26). Tonborg's review model reads candidate text as data, but
// a small model can still follow text that speaks to it. Whatever the model
// answers, an approval of a candidate whose text has the shape of an injection
// is never applied: the engine escalates it to the person and names these
// signals as the reason.
//
// The check reads text shape only (who it addresses, whether it sets the
// review's outcome, review or chat syntax, tool-call syntax, hidden
// characters). It needs no model and no Agent. It leans broad: a false
// positive costs one human review, a false negative is the dangerous case.
// It is not complete: a paraphrase, another language, an encoding or a false
// claim written as ordinary evidence passes it, so it adds to the confidence
// floor, the trust gate and the person's decision and replaces none of them.

const CJK = '\\u3400-\\u9fff';

const PATTERNS = Object.freeze({
  // Text that speaks to the reviewer or the model, or replaces its instructions.
  reviewer_instruction: [
    /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|system|original)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?|directions?)\b/i,
    /\b(?:ignore|disregard|forget|override)\s+(?:all|any|every|your)\s+(?:of\s+(?:the|your)\s+)?(?:instructions?|rules?|prompts?|directions?|guidelines?|policies)\b/i,
    /(?:忽略|无视|忘记|忘掉|覆盖)[^。\n]{0,12}(?:之前|以上|上面|前面|先前|原有|所有|全部|系统)[^。\n]{0,8}(?:指令|指示|规则|提示|要求|设定)/,
    /\b(?:tonborg|the model|the ai|llm|ai reviewer|knowledge reviewer)\b[^.\n]{0,20}\b(?:must|should|shall|needs? to|has to|is required to|please)\b[^.\n]{0,20}\b(?:approve|escalate|output|answer)\b/i,
    /\breviewer\s*:/i,
    /(?:审核员|审核人|审阅人|审查员|评审员|tonborg|模型|\bAI\b)[^。\n]{0,8}(?:请|必须|务必|应当|应该|需要|直接|只需)[^。\n]{0,8}(?:通过|批准|放行|approve|输出|保存)/i,
    /\b(?:all|every|each)\s+(?:of the\s+)?candidates?\b[^.\n]{0,30}\b(?:approve|save)/i,
    /(?:所有|全部|每条|每个|凡是|一切)[^。\n]{0,6}候选[^。\n]{0,12}(?:保存|通过|批准|放行|approve)/i
  ],
  // A claim that a system, host, administrator or the user already approved this item.
  authority_claim: [
    /\b(?:system|host|admin|administrator|developer)\s+(?:override|notice|instruction|message|note|approval|prompt)\s*:/i,
    /\b(?:pre-?approved|already\s+(?:been\s+)?(?:approved|confirmed|reviewed))\b/i,
    /\bhuman\s+(?:confirmation|approval|review)\s+(?:is\s+|was\s+|has been\s+)?(?:already\s+)?(?:recorded|given|granted|done|complete)/i,
    /(?:系统|宿主)(?:提示|通知|消息|指令|公告)\s*:/,
    /管理员(?:已经?)?(?:批准|审批|确认|通知|指令)\s*:|已经?(?:过|经|获|被)?管理员(?:批准|审批|确认)/,
    /(?:本条|此条|该条|这条)(?:候选|记录|内容)?[^。\n]{0,8}已经?(?:过|被|获|经)?(?:管理员|用户|人工|系统)?(?:审批|批准|确认|审核)/,
    /(?:本候选|此候选|该候选|这个候选)[^。\n]{0,8}(?:已|无需|不需要?|不必|不用)/
  ],
  // An attempt to set the review's outcome or confidence.
  outcome_directive: [
    /\b(?:do not|don't|never|no need to|without)\s+(?:escalat|ask(?:ing)?\s+the\s+(?:user|person|human))/i,
    new RegExp(`(?:无需|不需要?|不必|不用|别|勿|不要)\\s*(?:再)?\\s*(?:升级|上报)(?![${CJK}A-Za-z])`),
    /(?:无需|不需要?|不必|不用)\s*(?:再)?\s*(?:询问|征求|人工)/,
    /\boutcome\b["']?\s*[:=]?\s*["']?(?:approve|escalate)\b/i,
    /\b(?:output|return|respond with|answer with|reply with)\s+(?:only\s+)?["']?(?:approve|escalate)\b/i,
    /\bapprove\s+(?:this|the following|every|all|each)\s+(?:candidates?|items?|entr(?:y|ies)|records?)\b/i,
    /(?:请|直接|输出|返回|回答|给出)\s*["'“]?\s*(?:approve|escalate|通过|批准|放行)/i,
    /\bconfidence\b\s*(?:score\s*)?(?:[:=]|to|of|is|as|填|设为|设成|写成?|为)?\s*["']?(?:1(?:\.0+)?|0?\.\d+|100\s*%)(?![\d.])/i,
    /(?:置信度|信心|确信度)\s*(?:填|设为|设成|写成?|为|[:=])\s*["']?(?:1(?:\.0+)?|0?\.\d+|100\s*%)(?![\d.])/
  ],
  // Review prompt sections, chat-template turns or the review's own JSON.
  boundary_or_format: [
    /<\s*\/?\s*(?:data|task|decisions|system|assistant|instructions?)\s*>/i,
    /\b(?:TASK|DATA|DECISIONS)\s*:/,
    /<\|[a-z_]{2,30}\|>|\[\/?INST\]|<<\/?SYS>>/i,
    /"(?:decisions|outcome|confidence)"\s*:/i
  ],
  // Tool or function call syntax.
  tool_call: [
    /<\s*\/?\s*(?:tool_call|tool_use|function_calls?|invoke)\b/i,
    /"(?:tool_calls|function_call|tool_use)"\s*:/i,
    /\{\s*"name"\s*:\s*"[^"]{1,80}"\s*,\s*"(?:arguments|parameters|input)"\s*:/i
  ]
});

// Characters that hide or reorder text: zero-width spaces and non-joiners
// (the emoji joiner U+200D is ordinary), word joiners, byte order marks,
// bidirectional controls and Unicode tag characters.
const HIDDEN = /[​‌⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/u;
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

// The text a reader sees: invisible characters removed and full-width forms
// folded (NFKC), so neither splits or disguises a phrase.
function readableText(text) {
  return text.replace(INVISIBLE, '').normalize('NFKC').replace(/[ \t ]+/g, ' ');
}

function stringsOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  return value && typeof value === 'object' ? Object.values(value).flatMap(stringsOf) : [];
}

// The injection signals in any text of the candidate, in a fixed order; empty when none.
export function injectionSignals(candidate) {
  const texts = stringsOf(candidate);
  const readable = texts.map(readableText);
  const found = Object.entries(PATTERNS)
    .filter(([, patterns]) => readable.some(text => patterns.some(pattern => pattern.test(text))))
    .map(([signal]) => signal);
  return texts.some(text => HIDDEN.test(text)) ? [...found, 'hidden_characters'] : found;
}
