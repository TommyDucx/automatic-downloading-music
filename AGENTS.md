# AGENTS.md — 仓库约定

本仓库是音乐批量下载 skill（music-processing-skills）的源仓库，**仓库根目录即 skill 源文件**。

## 强制：skill 变更必须三方同步并推送 GitHub

每次更新 skill 后（改下载器 / 内嵌器 / SKILL.md / 其他脚本），必须完成以下三步，缺一不可：

1. **落在本仓库**：修改以仓库根目录为准（脚本 + SKILL.md）。
2. **同步安装副本**，保持与仓库一致：
   - `~/.config/opencode/skills/music-processing-skills/`（SKILL.md + `scripts/`）
   - `~/.workbuddy/skills/music-processing-skills/`（脚本在 `scripts/` 子目录）
3. **提交并推送**：`git add` 相关文件 → `git commit`（中文、简洁）→ `git push origin`
   （远端：https://github.com/TommyDucx/automatic-downloading-music.git）。

即：**仓库 ↔ 两个技能目录三方一致，且 GitHub 远端有记录**。

## 其他约定

- 下载的音乐与歌单等工作数据（`jazzhiphop/`、`playlist-exports/` 等）按需提交，不强制。
- 改脚本后至少做语法检查：`node --check <file>.js` / `python3 -m py_compile <file>.py`；
  动到抓取逻辑时用单曲实跑验证。
