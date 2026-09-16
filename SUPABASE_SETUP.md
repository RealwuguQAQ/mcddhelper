# Supabase 账号与云卡组配置

1. 登录 [Supabase](https://supabase.com/dashboard)，创建一个 Free 项目。
2. 打开 **SQL Editor**，粘贴并运行 `supabase-schema.sql` 的全部内容。它也会创建访问量与注册量统计函数；已有项目可以安全地重新运行完整脚本。
   - 已经创建过数据库时也需要重新运行一次；脚本会补充卡组环境字段和公开卡组查询索引，不会删除已有卡组。
3. 打开项目的 **Connect** 面板，复制 Project URL 和 Publishable key。
4. 把两个值填入 `config.js`。不要填写 Secret key 或旧版 `service_role` key。
5. 在 **Authentication → URL Configuration** 中设置：
   - Site URL：`https://realwuguqaq.github.io/mcddhelper/`
   - Redirect URLs：加入同一个网址。
6. 将 `config.js`、`supabase-schema.sql`、`SUPABASE_SETUP.md` 和本次网页代码一起提交到 GitHub。

未配置 Supabase 时，网站会自动保留现有的本机保存和分享链接模式。
