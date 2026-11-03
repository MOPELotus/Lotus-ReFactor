const userCommands = "米游社功能|荷花面板|米游币兑换|米游币商城"
const ownerCommands = "荷花管理面板|荷花配置"

export const USER_WEB_COMMAND_REG = `^#(?:${userCommands})$`
export const OWNER_WEB_COMMAND_REG = `^#(?:${ownerCommands})$`
export const WEB_COMMAND_EXCLUSION = `(?!#(?:${userCommands}|${ownerCommands})$)`
