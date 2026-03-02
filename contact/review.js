"use strict";

async function populateAddressBooks(selectEl, savedId) {
  while (selectEl.options.length > 0) selectEl.remove(0);

  let books = [];
  try {
    books = await browser.addressBooks.list();
  } catch (e) {
    console.error("[ThunderClerk-AI] Could not list address books:", e);
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(could not read address books)";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }

  // Filter to writable address books (exclude read-only)
  const writable = books.filter(b => !b.readOnly);

  if (writable.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no writable address books found)";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }

  for (const book of writable) {
    const opt = document.createElement("option");
    opt.value = book.id;
    opt.textContent = book.name;
    selectEl.appendChild(opt);
  }

  if (savedId) {
    selectEl.value = savedId;
    if (!selectEl.value) selectEl.selectedIndex = 0;
  } else {
    selectEl.selectedIndex = 0;
  }
}

async function init() {
  const { pendingContact, contactAddressBook } = await browser.storage.local.get({
    pendingContact: {},
    contactAddressBook: "",
  });

  // Pre-fill form fields
  document.getElementById("firstName").value = pendingContact.firstName || "";
  document.getElementById("lastName").value  = pendingContact.lastName  || "";
  document.getElementById("email").value     = pendingContact.email     || "";
  document.getElementById("phone").value     = pendingContact.phone     || "";
  document.getElementById("company").value   = pendingContact.company   || "";
  document.getElementById("jobTitle").value  = pendingContact.jobTitle  || "";
  document.getElementById("website").value   = pendingContact.website   || "";

  await populateAddressBooks(
    document.getElementById("addressBook"),
    contactAddressBook,
  );
}

async function saveContact() {
  const addressBookId = document.getElementById("addressBook").value;
  if (!addressBookId) {
    document.getElementById("status").textContent = "Please select an address book.";
    return;
  }

  const properties = {};
  const firstName = document.getElementById("firstName").value.trim();
  const lastName  = document.getElementById("lastName").value.trim();
  const email     = document.getElementById("email").value.trim();
  const phone     = document.getElementById("phone").value.trim();
  const company   = document.getElementById("company").value.trim();
  const jobTitle  = document.getElementById("jobTitle").value.trim();
  const website   = document.getElementById("website").value.trim();

  if (firstName) properties.FirstName     = firstName;
  if (lastName)  properties.LastName      = lastName;
  if (email)     properties.PrimaryEmail  = email;
  if (phone)     properties.CellularNumber = phone;
  if (company)   properties.Company       = company;
  if (jobTitle)  properties.JobTitle      = jobTitle;
  if (website)   properties.WebPage1      = website;

  // Display name fallback
  if (firstName || lastName) {
    properties.DisplayName = [firstName, lastName].filter(Boolean).join(" ");
  }

  try {
    await browser.contacts.create(addressBookId, properties);
  } catch (e) {
    console.error("[ThunderClerk-AI] Failed to create contact:", e);
    document.getElementById("status").textContent = "Failed to save: " + e.message;
    return;
  }

  // Signal background that the contact was actually saved (vs just closing)
  browser.runtime.sendMessage({ contactSaved: true }).catch(() => {});
  await browser.storage.local.remove("pendingContact");
  window.close();
}

async function cancel() {
  await browser.storage.local.remove("pendingContact");
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  document.getElementById("save-btn").addEventListener("click", saveContact);
  document.getElementById("cancel-btn").addEventListener("click", cancel);
});
