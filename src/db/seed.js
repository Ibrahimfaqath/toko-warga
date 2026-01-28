// src/db/seed.js
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users, categories } from './schema.js';
import bcrypt from 'bcryptjs';

// LOAD ENV
process.loadEnvFile();

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

async function seed() {
    console.log('Seeding dimulai...');

    // 1. Buat Admin (Pass: admin123)
    const hash = await bcrypt.hash('admin123', 10);
    await db.insert(users).values({
        username: 'admin',
        password: hash,
        role: 'admin'
    }).onConflictDoNothing();

    // 2. Buat Kategori
    await db.insert(categories).values([
        { name: 'Makanan' }, { name: 'Minuman' }, { name: 'Pakaian' }
    ]);

    console.log('Seeding selesai. Tekan ctrl+c untuk keluar.');
    process.exit(0);
}

seed();