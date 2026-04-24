import MarkdownIt from 'markdown-it'

const chatMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true
})

const defaultLinkOpenRenderer = chatMarkdown.renderer.rules.link_open

chatMarkdown.validateLink = (url) => /^(https?:|mailto:)/i.test(String(url || '').trim())

chatMarkdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const targetIndex = token.attrIndex('target')
  const relIndex = token.attrIndex('rel')

  if (targetIndex < 0) token.attrPush(['target', '_blank'])
  else token.attrs![targetIndex][1] = '_blank'

  if (relIndex < 0) token.attrPush(['rel', 'noreferrer'])
  else token.attrs![relIndex][1] = 'noreferrer'

  if (defaultLinkOpenRenderer) {
    return defaultLinkOpenRenderer(tokens, idx, options, env, self)
  }
  return self.renderToken(tokens, idx, options)
}

export function renderChatMessage(markdownText: string) {
  const source = String(markdownText || '').trim()
  if (!source) return '<p></p>'
  return chatMarkdown.render(source)
}