// ================================================================
// Controlled-vocabulary dropdowns
//
// A combobox backed by the seeded geotechnical vocabularies: the operator
// types to filter and picks a value rather than retyping it, which is what
// keeps the captured data aggregatable for the analytics layer.
//
// Choosing "Other…" reveals a free-text box. That value is usable on the
// record immediately — field work must never block waiting for an approval —
// but it is submitted as Pending and stays out of everyone else's dropdown
// until an admin approves it.
// ================================================================

let LOOKUPS = { categories: {}, options: {} };

async function loadLookups() {
  try {
    LOOKUPS = await api('GET', '/api/lookups');
  } catch (_) {
    LOOKUPS = { categories: {}, options: {} };
  }
}

function lookupValues(category) {
  return (LOOKUPS.options[category] || []).map((o) => o.value);
}

function lookupLabel(category) {
  return LOOKUPS.categories[category]?.label || category;
}

// Renders a searchable select. `name` is the form field name; the visible
// input is a filter, the hidden input carries the submitted value.
function lookupSelectHtml(category, name, value, opts = {}) {
  const values = lookupValues(category);
  const uid = `lk_${name}_${Math.random().toString(36).slice(2, 8)}`;
  const isCustom = value && !values.includes(value);
  const wrap = opts.full ? 'full' : '';
  const label = opts.label || lookupLabel(category);
  return `<div class="${wrap} lookup-field" data-lookup-category="${esc(category)}" data-lookup-uid="${uid}">
    <label>${esc(label)}${opts.required ? ' *' : ''}</label>
    <div class="lookup-control">
      <input type="text" class="lookup-input" id="${uid}-input" autocomplete="off" spellcheck="false"
             placeholder="${esc(opts.placeholder || 'Type to search…')}" value="${esc(value || '')}" />
      <input type="hidden" name="${esc(name)}" id="${uid}-value" value="${esc(value || '')}" />
      <div class="lookup-menu hidden" id="${uid}-menu"></div>
    </div>
    <div class="lookup-custom hidden" id="${uid}-custom">
      <input type="text" class="lookup-custom-input" id="${uid}-custom-input" placeholder="Enter the new value"
             value="${isCustom ? esc(value) : ''}" />
      <p class="lookup-hint">Submitted for supervisor approval before it joins the standard list.</p>
    </div>
  </div>`;
}

// Wires every lookup field inside `form`. Safe to call repeatedly — fields
// already wired are skipped, so rebuilding part of a form doesn't double-bind.
function wireLookups(form) {
  form.querySelectorAll('.lookup-field').forEach((field) => {
    if (field.dataset.wired === '1') return;
    field.dataset.wired = '1';

    const uid = field.dataset.lookupUid;
    const category = field.dataset.lookupCategory;
    const input = field.querySelector(`#${uid}-input`);
    const hidden = field.querySelector(`#${uid}-value`);
    const menu = field.querySelector(`#${uid}-menu`);
    const customWrap = field.querySelector(`#${uid}-custom`);
    const customInput = field.querySelector(`#${uid}-custom-input`);
    const values = lookupValues(category);

    // A value not in the approved list is either a pending custom value or a
    // legacy free-text entry — either way, show the custom box populated.
    if (hidden.value && !values.includes(hidden.value)) {
      customWrap.classList.remove('hidden');
      input.value = 'Other…';
    }

    let activeIndex = -1;

    function matches() {
      const q = input.value.trim().toLowerCase();
      const list = q && input.dataset.filtering === '1' ? values.filter((v) => v.toLowerCase().includes(q)) : values;
      return list.slice(0, 60);
    }

    function renderMenu() {
      const list = matches();
      const items = list
        .map((v, i) => `<div class="lookup-option${i === activeIndex ? ' active' : ''}" data-value="${esc(v)}">${esc(v)}</div>`)
        .join('');
      menu.innerHTML =
        (items || `<div class="lookup-empty">No match in the standard list</div>`) +
        `<div class="lookup-option lookup-other${activeIndex === list.length ? ' active' : ''}" data-value="__other__">Other…</div>`;
      menu.classList.remove('hidden');
      menu.querySelectorAll('.lookup-option').forEach((opt) => {
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(opt.dataset.value);
        });
      });
    }

    function choose(value) {
      if (value === '__other__') {
        customWrap.classList.remove('hidden');
        input.value = 'Other…';
        hidden.value = customInput.value.trim();
        customInput.focus();
      } else {
        customWrap.classList.add('hidden');
        customInput.value = '';
        input.value = value;
        hidden.value = value;
      }
      menu.classList.add('hidden');
      input.dataset.filtering = '0';
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
      form.dispatchEvent(new Event('lookup-change', { bubbles: true }));
    }

    input.addEventListener('focus', () => {
      input.dataset.filtering = '0';
      activeIndex = -1;
      renderMenu();
    });
    input.addEventListener('input', () => {
      input.dataset.filtering = '1';
      activeIndex = -1;
      renderMenu();
    });
    input.addEventListener('blur', () => {
      setTimeout(() => menu.classList.add('hidden'), 120);
      // Typing a value that exactly matches an approved option counts as picking it.
      const typed = input.value.trim();
      const exact = values.find((v) => v.toLowerCase() === typed.toLowerCase());
      const customOpen = !customWrap.classList.contains('hidden');
      if (exact) {
        input.value = exact;
        hidden.value = exact;
      } else if (!customOpen && typed !== 'Other…') {
        // Unrecognised free text with no custom box open: fall back to the
        // stored value so a half-typed filter never becomes the saved value.
        input.value = values.includes(hidden.value) ? hidden.value : '';
        if (!values.includes(hidden.value)) hidden.value = '';
      }
    });
    input.addEventListener('keydown', (e) => {
      const list = matches();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, list.length);
        renderMenu();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        renderMenu();
      } else if (e.key === 'Enter') {
        if (!menu.classList.contains('hidden')) {
          e.preventDefault();
          choose(activeIndex >= list.length ? '__other__' : list[activeIndex] ?? list[0]);
        }
      } else if (e.key === 'Escape') {
        menu.classList.add('hidden');
      }
    });

    customInput.addEventListener('input', () => {
      hidden.value = customInput.value.trim();
      hidden.dataset.custom = '1';
      hidden.dataset.category = category;
    });
  });
}

// After a successful save, register any custom values the operator entered so
// they enter the approval queue. Failures here are non-blocking: the record is
// already saved and the vocabulary can be fixed later.
async function submitCustomLookups(form) {
  const pending = [...form.querySelectorAll('input[type="hidden"][data-custom="1"]')];
  const submitted = [];
  for (const field of pending) {
    const value = field.value.trim();
    if (!value || !field.dataset.category) continue;
    try {
      const res = await api('POST', '/api/lookups', { category: field.dataset.category, value });
      if (res && res.status === 'Pending') submitted.push(value);
    } catch (_) {
      /* already submitted, or not permitted — record still saved */
    }
  }
  if (submitted.length) {
    toast(`"${submitted.join('", "')}" sent for approval`);
  }
}
