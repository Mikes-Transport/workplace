/* ============================================================
   firebase-init.js — MUST load BEFORE app.js
   Defines window.MTW = { db, $, $$, collection, getDocs, ... }
   so app.js can do:
     const { db, $, $$, collection, getDocs } = window.MTW;
   and use collection "workstation".

   Uses Firebase COMPAT SDKs (no build step, works on
   file:// and GitHub Pages). Wrappers expose a modular-style
   API on top of compat.
   ============================================================ */
(function () {
  // ----- DOM helpers (backward compatible) -----
  // Supports BOTH old style $("toast") [id] and $("#toast") / $(".card")
  function $(sel) {
    if (typeof sel !== 'string') return sel;
    var s = sel.trim();
    if (s.charAt(0) === '#' || s.charAt(0) === '.' || s.charAt(0) === '[') {
      return document.querySelector(s);
    }
    return document.getElementById(s) || document.querySelector(s);
  }
  function $$(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  // ----- 1. PASTE YOUR FIREBASE CONFIG HERE -----
  // Firebase Console → Project settings → Your apps → Web app → config
  var firebaseConfig = {
    apiKey: "PASTE_YOUR_API_KEY",
    authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
    projectId: "PASTE_YOUR_PROJECT_ID",
    storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
    messagingSenderId: "PASTE_SENDER_ID",
    appId: "PASTE_APP_ID"
  };

  var db = null;
  var configured = firebaseConfig.apiKey &&
    firebaseConfig.apiKey.indexOf('PASTE_') !== 0;

  // ----- Modular-style wrappers over compat SDK -----
  function wrapCollection(dbRef, path) {
    return dbRef.collection(path);
  }
  function wrapGetDocs(colRef) {
    // compat .get() returns a QuerySnapshot with .docs / .forEach / .empty
    return colRef.get();
  }
  function wrapDoc(dbRef, colPath, docId) {
    return dbRef.collection(colPath).doc(docId);
  }
  function wrapSetDoc(docRef, data, options) {
    return docRef.set(data, options);
  }
  function wrapGetDoc(docRef) {
    return docRef.get();
  }
  function wrapAddDoc(colRef, data) {
    return colRef.add(data);
  }
  function wrapDeleteDoc(docRef) {
    return docRef.delete();
  }
  function wrapOnSnapshot(ref, cb) {
    return ref.onSnapshot(cb);
  }

  if (configured && typeof firebase !== 'undefined') {
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
    } catch (e) {
      console.warn('[MTW] Firebase init failed, running offline:', e);
      db = null;
    }
  } else {
    if (typeof firebase === 'undefined') {
      console.warn('[MTW] Firebase SDK not loaded — check index.html script tags.');
    } else {
      console.warn('[MTW] Firebase config not filled in — running on localStorage. Paste config in firebase-init.js to enable cloud sync.');
    }
  }

  window.MTW = {
    db: db,
    $: $,
    $$: $$,
    // modular-style Firestore helpers (backed by compat)
    collection: wrapCollection,
    getDocs: wrapGetDocs,
    doc: wrapDoc,
    setDoc: wrapSetDoc,
    getDoc: wrapGetDoc,
    addDoc: wrapAddDoc,
    deleteDoc: wrapDeleteDoc,
    onSnapshot: wrapOnSnapshot,
    // meta
    isCloudEnabled: function () { return !!db; },
    WORKSTATION_COLLECTION: 'workstation',
    WORKSTATION_DOC: 'main'
  };
})();
