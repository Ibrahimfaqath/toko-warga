// src/db/schema.js
import { pgTable, serial, varchar, text, integer, numeric, timestamp } from 'drizzle-orm/pg-core';

// 1. Tabel Users (Admin)
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    username: varchar('username', { length: 100 }).unique().notNull(),
    password: varchar('password', { length: 256 }).notNull(),
    role: varchar('role', { length: 20 }).default('customer'),
});

// 2. Tabel categories
export const categories = pgTable('categories', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
});

// 3. Tabel products
export const products = pgTable('products', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 256 }).notNull(),
    description: text('description'),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    stock: integer('stock').notNull(),
    imageUrl: text('image_url'),
    categoryId: integer('category_id').references(() => categories.id),
});

// 4. Tabel orders
export const orders = pgTable('orders', {
    id: serial('id').primaryKey(),
    customerName: varchar('customer_name', { length: 256 }).notNull(),
    address: text('address').notNull(),
    totalAmount: numeric('total_amount', { precision: 12, scale:2 }).notNull(),
    status: varchar('status', { length: 20 }).default('pending'), // pending, paid
    createdAt: timestamp('created_at').defaultNow(),
});

// 5. Tabel Order Items (Detail Belanjaan)
export const orderItems = pgTable('order_items', {
    id: serial('id').primaryKey(),
    orderId: integer('order_id').references(() => orders.id).notNull(),
    productId: integer('product_id').references(() => products.id).notNull(),
    quantity: integer('quantity').notNull(),
    priceAtTime: numeric('price_at_time', { precision: 12, scale: 2 }).notNull(),
});