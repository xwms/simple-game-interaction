/**
 * 房间码输入组件
 *
 * 使用方式：<RoomCodeInput v-model="roomCode" />
 * 逻辑说明：6 位输入框，每个字符独立输入，自动转大写。
 *           输入后自动跳到下一格，退格回到上一格。
 */

<script setup lang="ts">
import { ref } from 'vue'

const model = defineModel<string>({ required: true })

// 6 个输入框的模板引用
const inputRefs = ref<(HTMLInputElement | null)[]>([])

/**
 * 功能描述：设置模板引用
 *
 * @param el - DOM 元素
 * @param index - 输入框索引
 */
function setInputRef(el: HTMLInputElement | null, index: number): void {
  inputRefs.value[index] = el
}

/**
 * 功能描述：处理输入事件
 *
 * 逻辑说明：自动转大写、过滤非法字符、自动跳到下一格。
 *
 * @param index - 当前输入框索引
 * @param event - 输入事件
 */
function onInput(index: number, event: Event): void {
  const target = event.target as HTMLInputElement
  const char = target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  target.value = char

  // 更新 model
  const chars = model.value.split('')
  chars[index] = char
  model.value = chars.join('').slice(0, 6)

  // 自动跳到下一格
  if (char && index < 5) {
    inputRefs.value[index + 1]?.focus()
  }
}

/**
 * 功能描述：处理退格键
 *
 * 逻辑说明：清空当前格内容，光标回到上一格。
 *
 * @param index - 当前输入框索引
 */
function onBackspace(index: number): void {
  const chars = model.value.split('')
  chars[index] = ''
  model.value = chars.join('')

  if (index > 0) {
    inputRefs.value[index - 1]?.focus()
  }
}
</script>

<template>
  <div class="room-code-input flex gap-2">
    <input
      v-for="i in 6"
      :key="i"
      :ref="(el: any) => setInputRef(el as HTMLInputElement | null, i - 1)"
      class="w-12 h-14 text-center text-2xl font-mono font-bold border rounded-lg uppercase"
      :value="model[i - 1] || ''"
      maxlength="1"
      @input="onInput(i - 1, $event)"
      @keydown.backspace.prevent="onBackspace(i - 1)"
    />
  </div>
</template>
