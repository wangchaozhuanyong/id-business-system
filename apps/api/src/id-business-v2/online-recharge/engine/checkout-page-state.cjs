'use strict';
/* global document, getComputedStyle */

// Runs in the page. Return fixed flags only, never page text, links or field values.
function checkoutPageFlags() {
  const text = globalThis.document.body?.innerText || '';
  const flags = {
    formTimeout: /payment form took too long to load/i.test(text),
    expired: /checkout session.*expired|session has expired|this checkout.*expired/i.test(text),
    configurePlan: /configure your plan|配置你的套餐/i.test(text),
    challenge: /just a moment|verify you are human|验证您是人类/i.test(text),
    processingError: false
  };
  let url;
  try {
    url = new URL(globalThis.location.href);
  } catch {
    return flags;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'chatgpt.com' ||
    url.port ||
    !/^\/checkout\//.test(url.pathname)
  )
    return flags;

  const visible = (node) => {
    if (
      node.closest(
        'template,[inert],[data-message-author-role],[data-testid^="conversation-turn"],article'
      )
    )
      return false;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        ['hidden', 'collapse'].includes(style.visibility) ||
        Number(style.opacity) === 0
      )
        return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const message = [...document.querySelectorAll('p,div,span,h1,h2,[role="alert"]')].some(
    (node) =>
      /^There was an error processing your payment\.?$/.test(node.textContent.trim()) &&
      visible(node)
  );
  if (!message) return flags;
  flags.processingError = [
    ...document.querySelectorAll('a,button,[role="link"],[role="button"]')
  ].some((node) => /^Return to ChatGPT$/i.test(node.textContent.trim()) && visible(node));
  return flags;
}

module.exports = { checkoutPageFlags };
