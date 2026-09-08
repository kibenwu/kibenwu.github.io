KivenWu's Blog
==============

> 技术美术 & 独立游戏开发的笔记与总结。

线上地址：<https://kibenwu.github.io>

主要内容：

- **TA（技术美术）**：UE5（Motion Matching / GASP / PCG / 贴图压缩）、Houdini VEX、Godot 光照等整理与拆解
- **独立游戏设计 & 书籍笔记**

Getting Started
---------------

1. 需要 [Ruby](https://www.ruby-lang.org/en/) 和 [Bundler](https://bundler.io/) 来运行 [Jekyll](https://jekyllrb.com/)。

2. 安装 `Gemfile` 中的依赖：

```sh
$ bundle install
```

3. 本地预览（默认 `localhost:4000`）：

```sh
$ bundle exec jekyll serve   # 或 npm start
```

Development
-----------

修改主题样式需要 [Grunt](https://gruntjs.com/)。`Gruntfile.js` 中包含压缩 JavaScript、把 `.less` 编译为 `.css`、watch 等任务。

- Jekyll 相关模板位于 `_includes/` 和 `_layouts/`（[Liquid](https://github.com/Shopify/liquid/wiki) 模板）
- 样式源文件在 `less/`，编译产物在 `css/`
- 文章放在 `_posts/`，配图放在 `img/in-post/` 或 `uploads/`
- 代码高亮使用 Jekyll 默认的 [Rouge](http://rouge.jneen.net/)，主题在 `less/highlight.less`

License
-------

文章内容版权归作者所有。

站点主题基于 [Hux Blog](https://github.com/Huxpro/huxpro.github.io)（Apache License 2.0, Copyright (c) 2015-present Huxpro），
后者派生自 [Clean Blog Jekyll Theme](https://github.com/BlackrockDigital/startbootstrap-clean-blog-jekyll/)（MIT License, Copyright (c) 2013-2016 Blackrock Digital LLC）。
