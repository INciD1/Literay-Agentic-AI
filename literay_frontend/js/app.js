// ===== view switching =====
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('view-' + item.dataset.view).classList.add('active');
  });
});

// ===== quiz interaction =====
document.querySelectorAll('.quiz-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    const card = opt.closest('.quiz-card');
    if (card.dataset.answered) return;
    card.dataset.answered = "true";

    const feedback = card.querySelector('.quiz-feedback');
    card.querySelectorAll('.quiz-opt').forEach(o => {
      if (o.dataset.correct === "true") o.classList.add('correct');
    });

    if (opt.dataset.correct !== "true") {
      opt.classList.add('wrong');
      feedback.textContent = "Not quite — force majeure is an exception that releases both parties from liability under Section 9.3.";
    } else {
      feedback.textContent = "That's right — force majeure is an exception that means neither party is liable.";
    }
    feedback.style.display = "block";
  });
});

// ===== simulated error state (for demo purposes) =====
const errorBtn = document.getElementById('simulate-error-btn');
if (errorBtn) {
  errorBtn.addEventListener('click', () => {
    const scroll = document.getElementById('chat-scroll');
    const err = document.createElement('div');
    err.className = 'error-card';
    err.innerHTML = `
      <div class="err-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>
        Couldn't reach the assistant
      </div>
      <div style="font-size:12.5px;color:var(--navy);">The server is responding slower than usual. Try sending your question again — nothing about your document has been lost.</div>
      <button class="btn btn-ghost" style="align-self:flex-start;">Try again</button>
    `;
    scroll.appendChild(err);
    scroll.scrollTop = scroll.scrollHeight;
  });
}

// ===== document switching (visual only, wire up to real fetch/render logic) =====
document.querySelectorAll('.doc-item').forEach(doc => {
  doc.addEventListener('click', () => {
    document.querySelectorAll('.doc-item').forEach(x => x.classList.remove('active'));
    doc.classList.add('active');
  });
});