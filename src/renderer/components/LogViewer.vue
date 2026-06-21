<script setup lang="ts">
/**
 * 日志查看器组件
 *
 * 使用方式：<LogViewer :logs="logs" />
 * 逻辑说明：类终端样式的日志列表。支持按级别过滤、行号显示、自动滚动锁定。
 *           自动滚动：用户位于底部时新日志自动滚到底，手动上翻时暂停。
 */

import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  logs: string[]
}>()

const containerRef = ref<HTMLDivElement | null>(null)
const { t } = useI18n()

// ─── 级别过滤 ──────────────────────────────────────────

type LogLevel = 'ALL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
const activeLevel = ref<LogLevel>('ALL')
const slideDir = ref<'left' | 'right'>('left')

const LEVEL_ORDER: LogLevel[] = ['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG']

/**
 * 功能描述：从日志行中提取日志级别
 *
 * @param text - 原始日志行文本
 * @returns 日志级别，无法识别则返回 null
 */
function extractLevel(text: string): LogLevel | null {
  const m = text.match(/\[(DEBUG|INFO|WARN|ERROR)\]/)
  return (m ? m[1] : null) as LogLevel | null
}

/**
 * 功能描述：根据级别过滤后的日志列表
 */
const filteredLogs = computed(() => {
  if (activeLevel.value === 'ALL') return props.logs
  return props.logs.filter((line) => extractLevel(line) === activeLevel.value)
})

/**
 * 功能描述：获取每种级别的计数
 */
const levelCounts = computed(() => {
  const counts: Record<string, number> = { ALL: props.logs.length }
  for (const line of props.logs) {
    const level = extractLevel(line) || 'ALL'
    counts[level] = (counts[level] || 0) + 1
  }
  return counts
})

/**
 * 功能描述：设置活动过滤级别，同时计算滑动方向
 *
 * @param level - 目标过滤级别
 */
function setLevel(level: LogLevel): void {
  const oldIdx = LEVEL_ORDER.indexOf(activeLevel.value)
  const newIdx = LEVEL_ORDER.indexOf(level)
  slideDir.value = newIdx > oldIdx ? 'left' : 'right'
  activeLevel.value = level
}

// ─── 自动滚动锁定 ──────────────────────────────────────

const enableAutoScroll = ref(true)

/**
 * 功能描述：检测当前滚动位置是否在底部
 *
 * 逻辑说明：距底部 8px 以内视为底部，启用自动滚动；
 *           反之上翻时暂停自动滚动。
 */
function onScroll(): void {
  const el = containerRef.value
  if (!el) return
  const threshold = 8
  enableAutoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * 功能描述：手动滚到底部
 */
function scrollToBottom(): void {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight
    enableAutoScroll.value = true
  }
}

// 新日志到达时自动滚动
watch(
  () => props.logs.length,
  async () => {
    if (!enableAutoScroll.value) return
    await nextTick()
    scrollToBottom()
  }
)

// ─── 日志级别样式 ──────────────────────────────────────

/**
 * 功能描述：解析日志等级并映射到样式类
 *
 * @param text - 原始日志行文本
 * @returns UnoCSS 颜色 class
 */
function levelClass(text: string): string {
  const m = text.match(/\[(DEBUG|INFO|WARN|ERROR)\]/)
  if (!m) return 'text-gray-100'
  switch (m[1]) {
    case 'ERROR': return 'text-red-400'
    case 'WARN':  return 'text-yellow-400'
    case 'INFO':  return 'text-blue-400'
    case 'DEBUG': return 'text-gray-500'
    default:     return 'text-gray-100'
  }
}

// ─── 过滤级别按钮配置 ───────────────────────────────────

const levelButtons: { level: LogLevel; label: string; class: string }[] = [
  { level: 'ALL',   label: 'ALL',   class: '' },
  { level: 'ERROR', label: 'ERROR', class: 'text-red-400' },
  { level: 'WARN',  label: 'WARN',  class: 'text-yellow-400' },
  { level: 'INFO',  label: 'INFO',  class: 'text-blue-400' }
]
</script>

<template>
  <div class="log-viewer flex flex-col rounded-xl overflow-hidden">
    <!-- 过滤器工具栏 -->
    <div class="flex items-center gap-1 px-4 py-2 border-b border-gray-800">
      <button
        v-for="btn in levelButtons"
        :key="btn.level"
        class="px-2.5 py-1 rounded text-xs font-mono transition-colors"
        :class="[
          btn.class,
          activeLevel === btn.level
            ? 'bg-gray-700! text-white!'
            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
        ]"
        @click="setLevel(btn.level)"
      >
        {{ btn.label }}
        <span class="ml-1 opacity-60">{{ levelCounts[btn.level] || 0 }}</span>
      </button>

      <div class="flex-1" />

      <!-- 自动滚动锁定状态 -->
      <button
        v-if="filteredLogs.length > 0 && !enableAutoScroll"
        class="px-2 py-1 rounded text-xs font-mono text-yellow-400 hover:bg-gray-800 transition-colors"
        @click="scrollToBottom"
      >
        ↓ {{ t('logs.scrollLatest') }}
      </button>
    </div>

    <!-- 日志列表 -->
    <div
      ref="containerRef"
      class="flex-1 p-4 text-xs font-mono overflow-y-auto select-text"
      @scroll="onScroll"
    >
      <div class="relative overflow-hidden min-h-full">
        <Transition :name="'slide-' + slideDir" mode="out-in">
          <div :key="activeLevel" class="w-full">
            <div v-if="filteredLogs.length === 0" class="text-gray-500">{{ t('logs.empty') }}</div>
            <div
              v-for="(line, index) in filteredLogs"
              :key="index"
              class="leading-relaxed flex gap-3"
              :class="levelClass(line)"
            >
              <span class="text-gray-600 select-none w-8 text-right shrink-0">{{ index + 1 }}</span>
              <span class="flex-1">{{ line }}</span>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>
