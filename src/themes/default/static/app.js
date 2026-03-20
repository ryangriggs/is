// is.am — Client-side utilities

// --- Copy to clipboard ---
// data-copy="text"        → copies the given text
// data-copy-target="id"   → copies the textContent of element with that ID
document.querySelectorAll('[data-copy],[data-copy-target]').forEach(el => {
  el.addEventListener('click', async () => {
    const text = el.dataset.copy ?? document.getElementById(el.dataset.copyTarget)?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      const orig = el.textContent
      el.textContent = 'Copied!'
      el.style.opacity = '0.7'
      setTimeout(() => { el.textContent = orig; el.style.opacity = '' }, 2000)
    } catch {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  })
})

// --- Flash message auto-dismiss ---
document.querySelectorAll('.flash-auto').forEach(el => {
  setTimeout(() => {
    el.style.transition = 'opacity 0.5s'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 500)
  }, 5000)
})

// --- Confirm dialogs for destructive actions ---
document.querySelectorAll('[data-confirm]').forEach(el => {
  el.addEventListener('click', e => {
    if (!confirm(el.dataset.confirm)) e.preventDefault()
  })
})

// --- URL validation on hero form ---
const heroForm = document.getElementById('hero-form')
const heroInput = document.getElementById('hero-url')
if (heroForm && heroInput) {
  heroForm.addEventListener('submit', e => {
    const val = heroInput.value.trim()
    if (!val.startsWith('http://') && !val.startsWith('https://')) {
      e.preventDefault()
      heroInput.focus()
      showInputError(heroInput, 'Please enter a valid URL starting with http:// or https://')
    }
  })
}

function showInputError(input, msg) {
  let err = input.nextElementSibling
  if (!err || !err.classList.contains('input-error')) {
    err = document.createElement('div')
    err.className = 'input-error text-sm mt-1'
    err.style.color = 'var(--color-danger)'
    input.parentNode.insertBefore(err, input.nextSibling)
  }
  err.textContent = msg
  setTimeout(() => err.remove(), 4000)
}

// --- Admin: select all checkboxes ---
const selectAll = document.getElementById('select-all')
if (selectAll) {
  selectAll.addEventListener('change', () => {
    document.querySelectorAll('.row-check').forEach(cb => {
      cb.checked = selectAll.checked
    })
  })
}
