const form = document.getElementById('contact-form');
const note = document.getElementById('form-note');
const year = document.getElementById('year');

year.textContent = new Date().getFullYear();

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  note.textContent = 'Sending...';

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Unable to send message');
    }

    note.textContent = data.message;
    form.reset();
  } catch (error) {
    note.textContent = error.message;
  }
});
