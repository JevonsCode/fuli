/// Bilingual plain-human-language copy dictionary (`zh-CN` / `en-US`).
/// Iron rule: zero internal jargon, enum names, or robotic phrasing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    ZhCn,
    EnUs,
}

impl Locale {
    pub fn from_code(code: &str) -> Self {
        if code.to_ascii_lowercase().starts_with("en") {
            Self::EnUs
        } else {
            Self::ZhCn
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::EnUs => "en-US",
        }
    }

    pub fn t(self, key: CopyKey) -> &'static str {
        match (self, key) {
            (Self::ZhCn, CopyKey::Brand) => "FULI 复利",
            (Self::EnUs, CopyKey::Brand) => "FULI",
            (Self::ZhCn, CopyKey::Tagline) => "让每一次协作，都产生复利",
            (Self::EnUs, CopyKey::Tagline) => "Make every collaboration compound",

            (Self::ZhCn, CopyKey::NavToday) => "工作台",
            (Self::EnUs, CopyKey::NavToday) => "Today",
            (Self::ZhCn, CopyKey::NavAgents) => "FULI Agent",
            (Self::EnUs, CopyKey::NavAgents) => "FULI Agents",
            (Self::ZhCn, CopyKey::NavMemory) => "记忆",
            (Self::EnUs, CopyKey::NavMemory) => "Memory",
            (Self::ZhCn, CopyKey::NavRoundtable) => "圆桌",
            (Self::EnUs, CopyKey::NavRoundtable) => "Roundtable",
            (Self::ZhCn, CopyKey::NavInspector) => "透视镜",
            (Self::EnUs, CopyKey::NavInspector) => "Inspector",
            (Self::ZhCn, CopyKey::NavSettings) => "设置",
            (Self::EnUs, CopyKey::NavSettings) => "Settings",

            (Self::ZhCn, CopyKey::WeeklyStatement) => "这周的复利账单",
            (Self::EnUs, CopyKey::WeeklyStatement) => "This Week's Compounding",
            (Self::ZhCn, CopyKey::CompoundingCountSub) => {
                "次过去定下的规矩和经验，这周真的帮你省了事"
            }
            (Self::EnUs, CopyKey::CompoundingCountSub) => {
                "times your past rules & experience saved effort this week"
            }
            (Self::ZhCn, CopyKey::WaitingForYou) => "等你拍板",
            (Self::EnUs, CopyKey::WaitingForYou) => "Needs Your Call",
            (Self::ZhCn, CopyKey::AllClearTitle) => "现在很清爽，没有需要你操心的事",
            (Self::EnUs, CopyKey::AllClearTitle) => "All clear — nothing needs your call right now",
            (Self::ZhCn, CopyKey::AllClearSub) => {
                "常规进展 FULI 会静默记好，只有真正冲突或大改动才会来问你。"
            }
            (Self::EnUs, CopyKey::AllClearSub) => {
                "Routine updates are recorded quietly; FULI only asks on real conflicts or major promotions."
            }

            (Self::ZhCn, CopyKey::DreamingTitle) => "定期整理建议（Dreaming）",
            (Self::EnUs, CopyKey::DreamingTitle) => "Periodic Curation (Dreaming)",
            (Self::ZhCn, CopyKey::DreamingRunBtn) => "立即扫描整理",
            (Self::EnUs, CopyKey::DreamingRunBtn) => "Run Scan Now",
            (Self::ZhCn, CopyKey::PortfolioTitle) => "跨项目近况（可直接写周报）",
            (Self::EnUs, CopyKey::PortfolioTitle) => "Across All Projects (Weekly Digest)",

            (Self::ZhCn, CopyKey::TabKnowledge) => "知识库",
            (Self::EnUs, CopyKey::TabKnowledge) => "Knowledge",
            (Self::ZhCn, CopyKey::TabRules) => "个人与项目偏好",
            (Self::EnUs, CopyKey::TabRules) => "Rules & Preferences",

            (Self::ZhCn, CopyKey::SearchPlaceholder) => {
                "输入中文或英文关键词搜索知识（回车即查）..."
            }
            (Self::EnUs, CopyKey::SearchPlaceholder) => {
                "Search knowledge in Chinese or English (Enter)..."
            }
            (Self::ZhCn, CopyKey::SearchBtn) => "搜索",
            (Self::EnUs, CopyKey::SearchBtn) => "Search",
            (Self::ZhCn, CopyKey::ClearBtn) => "清空",
            (Self::EnUs, CopyKey::ClearBtn) => "Clear",
            (Self::ZhCn, CopyKey::NewAgentBtn) => "+ 新建 FULI Agent",
            (Self::EnUs, CopyKey::NewAgentBtn) => "+ New FULI Agent",
            (Self::ZhCn, CopyKey::NewKnowledgeBtn) => "+ 记一条知识",
            (Self::EnUs, CopyKey::NewKnowledgeBtn) => "+ Add Knowledge",
            (Self::ZhCn, CopyKey::NewRuleBtn) => "+ 定一条规矩",
            (Self::EnUs, CopyKey::NewRuleBtn) => "+ Add Rule",
            (Self::ZhCn, CopyKey::SaveBtn) => "保存",
            (Self::EnUs, CopyKey::SaveBtn) => "Save",
            (Self::ZhCn, CopyKey::CancelBtn) => "取消",
            (Self::EnUs, CopyKey::CancelBtn) => "Cancel",
            (Self::ZhCn, CopyKey::CloseBtn) => "关闭",
            (Self::EnUs, CopyKey::CloseBtn) => "Close",
            (Self::ZhCn, CopyKey::HistoryBtn) => "版本历史",
            (Self::EnUs, CopyKey::HistoryBtn) => "Versions",
            (Self::ZhCn, CopyKey::CopyResumeBtn) => "复制续接命令",
            (Self::EnUs, CopyKey::CopyResumeBtn) => "Copy Resume",
            (Self::ZhCn, CopyKey::CopiedLabel) => "已复制",
            (Self::EnUs, CopyKey::CopiedLabel) => "Copied",

            (Self::ZhCn, CopyKey::ConfirmBtn) => "确认记下",
            (Self::EnUs, CopyKey::ConfirmBtn) => "Confirm",
            (Self::ZhCn, CopyKey::DismissBtn) => "先不要",
            (Self::EnUs, CopyKey::DismissBtn) => "Dismiss",
            (Self::ZhCn, CopyKey::PromoteHardBtn) => "升成红线",
            (Self::EnUs, CopyKey::PromoteHardBtn) => "Make Hard Rule",
            (Self::ZhCn, CopyKey::PickThisBtn) => "留这条",
            (Self::EnUs, CopyKey::PickThisBtn) => "Keep This",
            (Self::ZhCn, CopyKey::HelpfulBtn) => "有用 +1",
            (Self::EnUs, CopyKey::HelpfulBtn) => "Helpful +1",
            (Self::ZhCn, CopyKey::StaleBtn) => "过时了",
            (Self::EnUs, CopyKey::StaleBtn) => "Mark Stale",
            (Self::ZhCn, CopyKey::RefreshBtn) => "刷新数据",
            (Self::EnUs, CopyKey::RefreshBtn) => "Refresh",
            (Self::ZhCn, CopyKey::CloseAndFreeBtn) => "关窗并释放显存",
            (Self::EnUs, CopyKey::CloseAndFreeBtn) => "Close & Free GPU RAM",

            (Self::ZhCn, CopyKey::AutonomyTitle) => "你希望 FULI 平时有多主动？",
            (Self::EnUs, CopyKey::AutonomyTitle) => "How autonomous should FULI be?",
            (Self::ZhCn, CopyKey::AutonomyManual) => "每次都问我",
            (Self::EnUs, CopyKey::AutonomyManual) => "Always Ask",
            (Self::ZhCn, CopyKey::AutonomyAssist) => "给建议，我一键定",
            (Self::EnUs, CopyKey::AutonomyAssist) => "Suggest + 1-Click",
            (Self::ZhCn, CopyKey::AutonomyAuto) => "常规自动记（随时可撤回）",
            (Self::EnUs, CopyKey::AutonomyAuto) => "Auto Routine (Undoable)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyKey {
    Brand,
    Tagline,
    NavToday,
    NavAgents,
    NavMemory,
    NavRoundtable,
    NavInspector,
    NavSettings,
    WeeklyStatement,
    CompoundingCountSub,
    WaitingForYou,
    AllClearTitle,
    AllClearSub,
    DreamingTitle,
    DreamingRunBtn,
    PortfolioTitle,
    TabKnowledge,
    TabRules,
    SearchPlaceholder,
    SearchBtn,
    ClearBtn,
    NewAgentBtn,
    NewKnowledgeBtn,
    NewRuleBtn,
    SaveBtn,
    CancelBtn,
    CloseBtn,
    HistoryBtn,
    CopyResumeBtn,
    CopiedLabel,
    ConfirmBtn,
    DismissBtn,
    PromoteHardBtn,
    PickThisBtn,
    HelpfulBtn,
    StaleBtn,
    RefreshBtn,
    CloseAndFreeBtn,
    AutonomyTitle,
    AutonomyManual,
    AutonomyAssist,
    AutonomyAuto,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bilingual_locale_resolves_clean_human_copy() {
        assert_eq!(Locale::from_code("zh-CN"), Locale::ZhCn);
        assert_eq!(Locale::from_code("en-US"), Locale::EnUs);
        assert_eq!(Locale::ZhCn.t(CopyKey::Tagline), "让每一次协作，都产生复利");
        assert_eq!(
            Locale::EnUs.t(CopyKey::Tagline),
            "Make every collaboration compound"
        );
    }
}
