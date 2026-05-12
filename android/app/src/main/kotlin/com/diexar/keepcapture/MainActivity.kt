package com.diexar.keepcapture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.diexar.keepcapture.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val pickVaultLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri: Uri? ->
        if (uri != null) {
            Storage.persistUriPermission(this, uri)
            Storage.saveVaultUri(this, uri)
            updateUi()
            toast(getString(R.string.toast_vault_picked))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.pickVaultButton.setOnClickListener {
            pickVaultLauncher.launch(null)
        }

        binding.saveSubfolderButton.setOnClickListener {
            val name = binding.subfolderInput.text?.toString().orEmpty()
            Storage.saveSubfolder(this, name)
            updateUi()
            toast(getString(R.string.toast_subfolder_saved))
        }

        binding.testButton.setOnClickListener {
            val result = Storage.saveNote(this, getString(R.string.test_note_body))
            result.onSuccess { name ->
                toast(getString(R.string.toast_saved, name))
            }.onFailure { err ->
                toast(getString(R.string.toast_error, err.message ?: "onbekende fout"))
            }
        }

        binding.kofiButton.setOnClickListener {
            openExternalUrl("https://ko-fi.com/L3L11ZETB9")
        }

        setupSpeechLangSpinner()
    }

    private fun openExternalUrl(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
        } catch (e: Exception) {
            toast(getString(R.string.toast_error, e.message ?: "geen browser"))
        }
    }

    private fun setupSpeechLangSpinner() {
        val labels = Storage.SUPPORTED_SPEECH_LANGS.map { it.second }
        val codes = Storage.SUPPORTED_SPEECH_LANGS.map { it.first }
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
        binding.speechLangSpinner.adapter = adapter
        val currentIndex = codes.indexOf(Storage.getSpeechLanguage(this)).coerceAtLeast(0)
        binding.speechLangSpinner.setSelection(currentIndex, false)
        binding.speechLangSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val code = codes.getOrNull(position) ?: return
                if (code != Storage.getSpeechLanguage(this@MainActivity)) {
                    Storage.saveSpeechLanguage(this@MainActivity, code)
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
    }

    override fun onResume() {
        super.onResume()
        updateUi()
    }

    private fun updateUi() {
        val vaultUri = Storage.getVaultUri(this)
        binding.vaultPath.text = if (vaultUri != null) {
            Uri.decode(vaultUri.toString())
        } else {
            getString(R.string.no_vault_picked)
        }
        binding.subfolderInput.setText(Storage.getSubfolder(this))
        binding.testButton.isEnabled = vaultUri != null
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
