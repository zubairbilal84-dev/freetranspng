const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/freetranspng')
.then(() => console.log('MongoDB Connected Successfully!'))
.catch(err => console.log('DB Connection Error:', err));

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }
});
const Category = mongoose.model('Category', categorySchema);

const pngSchema = new mongoose.Schema({
    title: { type: String, required: true },
    category: { type: String, required: true },
    tags: { type: String, required: true },
    imageUrl: { type: String, required: true },
    downloads: { type: Number, default: 0 }
});
const Png = mongoose.model('Png', pngSchema);

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, path.join(__dirname, 'public/uploads')); },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-')); }
});
const upload = multer({ storage: storage });

// --- ROUTES ---

app.get('/', async (req, res) => {
    try {
        const search = req.query.search || '';
        const selectedCategory = req.query.category || '';
        
        let query = {};
        if (selectedCategory) {
            query.category = selectedCategory;
        } else if (search) {
            query = { 
                $or: [
                    { title: { $regex: search, $options: 'i' } },
                    { tags: { $regex: search, $options: 'i' } },
                    { category: { $regex: search, $options: 'i' } }
                ] 
            };
        }
        
        const pngs = await Png.find(query).sort({ _id: -1 });
        const categories = await Category.find().sort({ name: 1 });
        res.render('index', { pngs, search, categories, selectedCategory });
    } catch (err) { res.status(500).send("Server Error"); }
});

// E-commerce Style Product Detail Page & Recommendations Route
app.get('/png/:id', async (req, res) => {
    try {
        const png = await Png.findById(req.params.id);
        if (!png) return res.status(404).send("PNG not found");
        
        // Track download/view click count increase
        png.downloads += 1;
        await png.save();

        // Same category ke 4 recommended items fetch karna
        const recommendations = await Png.find({ category: png.category, _id: { $ne: png._id } }).limit(4);
        res.render('detail', { png, recommendations });
    } catch (err) { res.status(500).send("Server Error"); }
});

// Purana download route support ke liye (optional redirect)
app.get('/download/:id', async (req, res) => {
    res.redirect(`/png/${req.params.id}`);
});

// Static Pages for AdSense & Navigation
app.get('/about', (req, res) => {
    res.render('about');
});

app.get('/contact', (req, res) => {
    res.render('contact');
});

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

// Admin Dashboard - Updated to handle category filter & search
app.get('/admin', async (req, res) => {
    try {
        const searchAdmin = req.query.search || '';
        const selectedCategory = req.query.category || '';
        
        let query = {};
        if (selectedCategory && searchAdmin) {
            query = {
                category: selectedCategory,
                $or: [
                    { title: { $regex: searchAdmin, $options: 'i' } },
                    { tags: { $regex: searchAdmin, $options: 'i' } }
                ]
            };
        } else if (selectedCategory) {
            query.category = selectedCategory;
        } else if (searchAdmin) {
            query = { 
                $or: [
                    { title: { $regex: searchAdmin, $options: 'i' } },
                    { tags: { $regex: searchAdmin, $options: 'i' } },
                    { category: { $regex: searchAdmin, $options: 'i' } }
                ] 
            };
        }
        
        const pngs = await Png.find(query).sort({ _id: -1 });
        const categories = await Category.find().sort({ name: 1 });
        const totalPngs = await Png.countDocuments();
        const totalDownloads = await Png.aggregate([{ $group: { _id: null, sum: { $sum: "$downloads" } } }]);
        const sumDownloads = totalDownloads.length > 0 ? totalDownloads[0].sum : 0;

        res.render('admin', { pngs, categories, totalPngs, sumDownloads, searchAdmin, selectedCategory });
    } catch (err) { res.status(500).send("Server Error"); }
});

// Separate Category Management Page
app.get('/admin/categories', async (req, res) => {
    try {
        const searchCat = req.query.search || '';
        const query = searchCat ? { name: { $regex: searchCat, $options: 'i' } } : {};
        const categories = await Category.find(query).sort({ name: 1 });
        res.render('categories', { categories, searchCat });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.post('/admin/category/add', async (req, res) => {
    try {
        const { name } = req.body;
        if (name) {
            await Category.updateOne({ name: name.trim() }, { name: name.trim() }, { upsert: true });
        }
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error adding category"); }
});

app.post('/admin/category/delete/:id', async (req, res) => {
    try {
        await Category.findByIdAndDelete(req.params.id);
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error deleting category"); }
});

app.post('/admin/upload', upload.single('pngImage'), async (req, res) => {
    try {
        const { title, category, tags } = req.body;
        if (!req.file) return res.status(400).send("No file uploaded!");
        await Png.create({ title, category, tags, imageUrl: `/uploads/${req.file.filename}` });
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Error uploading file"); }
});

app.get('/admin/edit/:id', async (req, res) => {
    try {
        const png = await Png.findById(req.params.id);
        const categories = await Category.find().sort({ name: 1 });
        if (!png) return res.status(404).send("PNG not found");
        res.render('edit', { png, categories });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.post('/admin/update/:id', upload.single('pngImage'), async (req, res) => {
    try {
        const { title, category, tags } = req.body;
        let updateData = { title, category, tags };
        
        if (req.file) {
            updateData.imageUrl = `/uploads/${req.file.filename}`;
        }

        await Png.findByIdAndUpdate(req.params.id, updateData);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Error updating PNG"); }
});

app.post('/admin/delete/:id', async (req, res) => {
    try {
        await Png.findByIdAndDelete(req.params.id);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Error deleting file"); }
});

app.listen(process.env.PORT || 5001, () => {
    console.log(`Server running at http://localhost:${process.env.PORT || 5001}`);
});