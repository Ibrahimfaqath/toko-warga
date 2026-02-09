import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users, categories, products, orderItems, orders } from './schema.js';
import bcrypt from 'bcryptjs';

process.loadEnvFile();

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

async function seed() {
    console.log('🧹 Membersihkan database secara total...');
    
    try {
        // URUTAN PENGHAPUSAN: Hapus yang bergantung dulu (Detail -> Utama)
        await db.delete(orderItems);
        await db.delete(orders);
        await db.delete(products); // Hapus produk dulu agar kategori bisa dihapus
        await db.delete(categories);
        
        console.log('✅ Database bersih. Mulai memasukkan data baru...');

        // 1. Buat Admin
        const hash = await bcrypt.hash('admin123', 10);
        await db.insert(users).values({
            username: 'admin',
            password: hash,
            role: 'admin'
        }).onConflictDoNothing();

        // 2. Buat Kategori Coffee & Resto (Pakaian sudah tidak ada)
        const newCats = await db.insert(categories).values([
            { name: 'Coffee' },
            { name: 'Non-Coffee' },
            { name: 'Makanan' },
            { name: 'Cemilan' }
        ]).returning();

        console.log('✅ Seeding Selesai!');
        console.log('Kategori saat ini:', newCats.map(c => c.name).join(', '));
        
    } catch (error) {
        console.error('❌ Gagal Seeding:', error.message);
    } finally {
        process.exit(0);
    }
}

seed();