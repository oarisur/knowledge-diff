// Fixture: a realistic unified diff for a Redux → Zustand migration
export const REDUX_TO_ZUSTAND_PATCH = `
@@ -1,12 +1,10 @@
-import { createSlice, PayloadAction } from '@reduxjs/toolkit';
+import { create } from 'zustand';
 
-interface CartState {
-  items: string[];
-}
-
-const cartSlice = createSlice({
-  name: 'cart',
-  initialState: { items: [] } as CartState,
-  reducers: {
-    addItem: (state, action: PayloadAction<string>) => {
-      state.items.push(action.payload);
-    },
-  },
-});
-
-export const { addItem } = cartSlice.actions;
-export default cartSlice.reducer;
+interface CartStore {
+  items: string[];
+  addItem: (item: string) => void;
+}
+
+export const useCartStore = create<CartStore>((set) => ({
+  items: [],
+  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
+}));
`.trim();

// Fixture: diff that changes an API endpoint path
export const API_ROUTE_PATCH = `
@@ -5,7 +5,7 @@
 import express from 'express';
 const router = express.Router();
 
-router.get('/api/v1/users', async (req, res) => {
+router.get('/api/v2/users', async (req, res) => {
   const users = await db.users.findAll();
   res.json(users);
 });
`.trim();

// Fixture: diff that switches from PostgreSQL to MongoDB
export const DB_SWITCH_PATCH = `
@@ -1,8 +1,8 @@
-import { Pool } from 'pg';
+import { MongoClient } from 'mongodb';
 
-const pool = new Pool({ connectionString: process.env.DATABASE_URL });
+const client = new MongoClient(process.env.MONGO_URI!);
 
 export async function getUser(id: string) {
-  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
-  return result.rows[0];
+  const db = client.db('myapp');
+  return db.collection('users').findOne({ _id: id });
 }
`.trim();

// Fixture: a completely unrelated diff (CSS change) — should produce no drift
export const UNRELATED_CSS_PATCH = `
@@ -10,4 +10,4 @@
 .container {
-  background-color: #fff;
+  background-color: #f5f5f5;
   padding: 16px;
 }
`.trim();

// Fixture: diff that changes a default model name (config value change)
export const MODEL_NAME_CHANGE_PATCH = `
@@ -55,7 +55,7 @@
 const DEFAULT_MODELS: Record<LLMProvider, string> = {
-  openai: "gpt-4o",
+  openai: "gpt-4o-mini",
   anthropic: "claude-3-5-sonnet-20241022",
   gemini: "gemini-2.5-flash",
 };
`.trim();

// Fixture: GitHub PR file list entries
export function makePRFile(
  filename: string,
  patch: string,
  status: "added" | "modified" | "removed" = "modified"
) {
  return { filename, patch, status };
}
