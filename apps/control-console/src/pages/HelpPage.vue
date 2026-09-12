<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getAgentConfig } from '../services/controlApi'

const helpConfig = ref<any>(null)

onMounted(async () => {
  try {
    const res = await getAgentConfig('hermes-manager')
    if (res.ok) helpConfig.value = await res.json().catch(() => null)
  } catch {
    // 配置读取失败时按基准默认值展示，不阻断帮助页
  }
})
</script>

<template>
  <div class="page-help">
    <section class="help-welcome">
      <h2>使用帮助</h2>
      <p>守护台的基础配置、支持功能、问法与测试、注意事项与暂未支持清单。</p>
    </section>

    <section class="help-section">
      <h3>基础配置</h3>
      <ul>
        <li>文本模型：{{ helpConfig?.config?.provider || 'omlx' }} / {{ helpConfig?.config?.model || '-' }}</li>
        <li>上下文预算 {{ helpConfig?.config?.contextLength || 8192 }} tokens，输出预留 {{ helpConfig?.config?.recommendedMaxOutputTokens || 2048 }} tokens</li>
        <li>对话记忆：保留最近 {{ helpConfig?.config?.workflow?.replayWindowMessages ?? 6 }} 条对话，超出自动压缩为摘要；更早历史走外部检索，不用重复粘贴背景</li>
        <li>运行环境：32G 内存本机，模型可用 23–25G；推理与出图自动互斥，不会同时占内存</li>
      </ul>
    </section>

    <section class="help-section">
      <h3>支持的功能</h3>
      <ul>
        <li>守护台问答：聊天窗直接提问，边想边答，每轮证据可追溯</li>
        <li>只读查证：可要求它读文件、列目录、全文搜索（control 在工作区内代为执行，安全只读），基于真实项目事实回答</li>
        <li>写操作确认卡：请求修改（如"把故事重命名为《X》"）时会弹出确认卡，你点「确认执行」后才经审核门禁真正写入，全程留痕；不会擅自改你的项目</li>
        <li>生产推进确认卡：故事创建后说"继续出场景图/补齐资产"等，会弹出资产计划提案卡，确认后进入场景图生产链（资产计划 → 参考图锁定 → 场景渲染 → 校验导出，每步都需你审核）；纯分析提问（"它缺什么"）走只读查证，不会误触生产</li>
        <li>锁定阶段直达：聊天里说"环境体检 / 生成 Story Bible / 主参考锁定 / 锁定测试 / 渲染缺失场景"即可触发对应功能——体检类只读直出结果，写/生成类弹确认卡经你批准才执行</li>
        <li>跨轮记忆：近期对话自动记忆（如约定暗号后隔轮提问仍能召回）</li>
        <li>对话水位管理：长聊不中断——历史接近上下文预算时系统提示，确认后压缩早期对话为摘要或清空重开，当前话题方向不变</li>
        <li>会话历史：点输入区左侧「会话历史」管理每次会话——新建会话时自动归档当前会话，打开历史会话可继续，可删除；记录按会话一个文件存 ai/chat/sessions/，跨天自动回填不"失忆"</li>
        <li>故事生产：祈使句下达（如「创建一个悬疑故事项目」），自动执行 创建 → 脚本 → 蓝图 → 评审 → 导出 全链</li>
        <li>审核门禁：写入、删除、导出、生产动作必须经你批准</li>
        <li>项目库、任务会话、历史检索：全程留痕，失败明示原因</li>
      </ul>
    </section>

    <section class="help-section">
      <h3>问法与测试</h3>
      <ul>
        <li>即问即答：「是什么 / 为什么 / 如何 / …吗」的独立问题走轻量问答通道</li>
        <li>带指代或祈使句（刚才 / 继续 / 创建…）走任务链通道：更稳但稍慢，人工模式每轮需你批准 1–2 次；聊天设置可开自动放行</li>
        <li>分组测试题库（A 冒烟 / B 记忆 / C 长线 / D 分流 / E 证据）见 docs/运行时能力测试基准.md</li>
      </ul>
    </section>

    <section class="help-section">
      <h3>用户注意事项</h3>
      <ul>
        <li>本地 27B 模型单轮回答 1–2 分钟属正常，请勿反复重发</li>
        <li>机器重启后显存上限会复位：首次只需执行一次 <code>sudo bash scripts/utils/install_iogpu_sudoers.sh</code>，之后每次启动由系统自动提限并自愈（探测→提限→重启 OMLX→复测），无需手工处理</li>
        <li>失败会明确显示原因；看到失败提示不要当成已回答</li>
        <li>出图与问答共用内存，系统自动排队，请勿手动并行触发</li>
      </ul>
    </section>

    <section class="help-section">
      <h3>暂未支持</h3>
      <ul>
        <li>16K 上下文（当前 8192 tokens，后续开放）</li>
        <li>「是多少度 / 有哪些」等部分问句会落入较重的任务链通道（答案正确但稍慢）</li>
        <li>场景图 / 立绘等图片生产的全自动闭环（出图须经三级人工审核，且与问答分时使用内存）</li>
        <li>hermes 原生 Web UI / TUI、多渠道接入、多用户与远程访问（守护台是本机唯一操作界面）</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page-help {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 960px;
}

.help-welcome h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--c-text-inv);
}

.help-welcome p {
  margin: 0;
  color: var(--c-text-sub);
}

.help-section {
  padding: 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.help-section h3 {
  margin: 0 0 10px;
  font-size: 14px;
  color: var(--c-accent);
}

.help-section ul {
  margin: 0;
  padding-left: 20px;
  color: var(--c-text-sub);
  font-size: 13px;
  line-height: 1.8;
}

.help-section code {
  font-size: 12px;
  color: var(--c-text);
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  padding: 1px 5px;
}
</style>
