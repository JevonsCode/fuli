"""Occupation definitions and input contract; these are not task-entry context."""

from datetime import datetime
from typing import Literal
from pydantic import Field, field_validator, model_validator
from .model_base import StrictModel

# The occupation each fixed identity ships with: stored on the Agent when the
# identity is created, read back from there, and never reassigned by a person
# (occupation_locked). Bole is AR, so it holds Agent resources (graph/12).
BUILTIN_AGENT_OCCUPATIONS = {
    'employee.jefa': 'management', 'employee.bole': 'hr',
    'employee.tonborg': 'management', 'employee.assistant': 'assistant',
}

_BUILTINS = [
    ('lead', '负责人', 'Lead', '拆分项目目标、安排分工并统筹交付。', 'Break down project goals, delegate work, and coordinate delivery.'),
    ('assistant', '助手', 'Assistant', '接待对话并协助处理当前任务。', 'Handle conversations and help with the current task.'),
    ('product', '产品', 'Product', '明确用户需求、产品范围和验收标准。', 'Define user needs, product scope, and acceptance criteria.'),
    ('engineering', '工程', 'Engineering', '实现和维护软件并验证工程质量。', 'Implement and maintain software and verify its quality.'),
    ('design', '设计', 'Design', '设计易用的交互、视觉和产品体验。', 'Design usable interactions, visuals, and product experiences.'),
    ('operations', '运营', 'Operations', '维护日常运营流程并跟进执行结果。', 'Maintain daily operations and follow up on their results.'),
    ('testing', '测试', 'Testing', '验证功能和边界并报告可复现问题。', 'Verify behavior and edge cases and report reproducible defects.'),
    ('research', '研究', 'Research', '查证资料、比较方案并给出有依据的结论。', 'Investigate sources, compare approaches, and provide supported conclusions.'),
    ('data', '数据', 'Data', '核验和分析数据并解释指标变化。', 'Validate and analyze data and explain metric changes.'),
    ('writing', '写作', 'Writing', '撰写和修改适合目标读者的内容。', 'Write and revise content for its intended audience.'),
    ('management', '管理', 'Management', '规划工作、协调资源并追踪项目进展。', 'Plan work, coordinate resources, and track project progress.'),
    ('frontend', '前端', 'Frontend', '实现和维护用户界面及浏览器端交互。', 'Build and maintain user interfaces and browser interactions.'),
    ('backend', '后端', 'Backend', '实现和维护服务接口、业务规则及存储。', 'Build and maintain service APIs, domain rules, and storage.'),
    ('mobile', '移动端', 'Mobile', '开发和维护移动应用及设备端体验。', 'Develop and maintain mobile applications and device experiences.'),
    ('devops', '开发运维', 'DevOps', '维护构建、部署、运行环境和故障恢复。', 'Maintain builds, deployments, runtime environments, and recovery.'),
    ('security', '安全', 'Security', '检查安全边界、识别风险并验证修复。', 'Inspect security boundaries, identify risks, and verify fixes.'),
    ('qa_automation', '自动化测试', 'QA automation', '建立和维护自动测试及持续质量检查。', 'Build and maintain automated tests and continuous quality checks.'),
    ('architecture', '架构', 'Architecture', '设计系统边界、组件协作和演进方案。', 'Design system boundaries, component collaboration, and evolution.'),
    ('documentation', '文档', 'Documentation', '维护清楚、准确且可操作的技术文档。', 'Maintain clear, accurate, and actionable technical documentation.'),
    ('translation', '翻译', 'Translation', '在保留原意的前提下翻译和校对内容。', 'Translate and review content while preserving its meaning.'),
    ('marketing', '市场', 'Marketing', '规划市场内容和活动并分析传播效果。', 'Plan marketing content and campaigns and assess their effectiveness.'),
    ('support', '支持', 'Support', '理解用户问题、提供帮助并跟进解决。', 'Understand user issues, provide help, and follow through on resolution.'),
    ('finance', '财务', 'Finance', '整理财务资料、核对账目并分析预算。', 'Organize financial records, reconcile accounts, and analyze budgets.'),
    ('legal', '法务', 'Legal', '整理法律资料、核对条款并提示相关风险。', 'Review legal materials and terms and identify relevant risks.'),
    # Agents, not people: the key stays 'hr' so stored roles keep working (graph/12).
    ('hr', 'Agent 资源', 'Agent resources', '维护 Agent 的职责、招募安排和人员配置记录。', 'Maintain Agent roles, recruitment arrangements, and staffing records.'),
]
BUILTIN_OCCUPATIONS = [dict(zip(
    ('key', 'name_zh', 'name_en', 'description_zh', 'description_en'), entry,
)) for entry in _BUILTINS]
BUILTIN_OCCUPATION_KEYS = [entry['key'] for entry in BUILTIN_OCCUPATIONS]
TEXT_FIELDS = ('name_zh', 'name_en', 'description_zh', 'description_en')


class OccupationFields(StrictModel):
    name_zh: str | None = Field(default=None, max_length=120)
    name_en: str | None = Field(default=None, max_length=120)
    description_zh: str | None = Field(default=None, max_length=2000)
    description_en: str | None = Field(default=None, max_length=2000)

    @field_validator(*TEXT_FIELDS)
    @classmethod
    def meaningful_text(cls, value, info):
        if value is None:
            raise ValueError('provided occupation text cannot be null')
        value = value.strip()
        minimum = 8 if info.field_name.startswith('description') else 1
        if len(value) < minimum or not any(char.isalnum() for char in value):
            raise ValueError(f'{info.field_name} must explain the work in at least {minimum} characters')
        return value


class OccupationCreate(OccupationFields):
    personal_space_id: str = Field(min_length=1, max_length=128)

    @model_validator(mode='before')
    @classmethod
    def omit_blank_optional_locales(cls, value):
        if isinstance(value, dict):
            return {key: item for key, item in value.items()
                    if key not in TEXT_FIELDS or not (item is None or isinstance(item, str) and not item.strip())}
        return value

    @model_validator(mode='after')
    def require_name_and_work(self):
        if not (self.name_zh or self.name_en) or not (self.description_zh or self.description_en):
            raise ValueError('occupation name and description of the work are required')
        self.name_zh = self.name_zh or self.name_en
        self.name_en = self.name_en or self.name_zh
        self.description_zh = self.description_zh or self.description_en
        self.description_en = self.description_en or self.description_zh
        return self


class OccupationRevision(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(ge=0, strict=True)


class OccupationUpdate(OccupationFields, OccupationRevision):
    status: Literal['active', 'archived'] | None = None

    @model_validator(mode='after')
    def require_change(self):
        if not (self.model_fields_set & (set(TEXT_FIELDS) | {'status'})):
            raise ValueError('at least one occupation edit is required')
        if 'status' in self.model_fields_set and self.status is None:
            raise ValueError('occupation status cannot be null')
        return self


class OccupationEntry(StrictModel):
    key: str
    name_zh: str
    name_en: str
    description_zh: str
    description_en: str
    builtin: bool
    status: Literal['active', 'archived']
    created_at: datetime
    updated_at: datetime
    revision: int
    agent_count: int = 0
