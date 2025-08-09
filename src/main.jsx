import React from 'react'
import ReactDOM from 'react-dom/client'

// PROOF this file loaded:
console.log('>>> main.jsx loaded');
alert('App loaded (temporary test)');

function App() {
  return (
    <div style={{minHeight:'100vh', background:'#020617', color:'#f1f5f9', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'system-ui'}}>
      <div style={{padding:16, border:'1px solid #1f2937', borderRadius:14, background:'rgba(15,23,42,.4)'}}>
        <h1 style={{margin:0}}>Render check</h1>
        <p>If you can see this, deploy + routing are fine.</p>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
